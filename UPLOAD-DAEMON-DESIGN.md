# ColdStorage — Upload Daemon Design (V1)

> The crown jewel (see memory: upload robustness is V1-critical). A **standalone native Swift daemon** that ingests, encrypts, and uploads to Glacier Deep Archive — resumable through anything, integrity-checked end to end, observable. The Electron/React app is only a control panel talking to it over local IPC.
> AWS facts below verified June 2026 (AWS SDK for Swift GA; S3 multipart + SHA-256 checksums; Glacier Deep Archive multipart billing) — see Sources in the chat message.

---

## 1. Processes & lifecycle

- **`coldstored` (Swift daemon)** — does all the real work. Runs as a **`launchd` LaunchAgent** (per-user, `RunAtLoad` + `KeepAlive` for auto-restart after crash/logout/reboot). LaunchAgent (not LaunchDaemon) because it must run **in the user session** to reach the Photos library (TCC) and Keychain.
- **Electron/React app** — a **control panel + observer**. Owns no upload state. Connects to the daemon over a **local Unix-domain socket** (JSON-RPC + an event stream). Can be closed/crashed/reopened freely; uploads keep running.
- **Single source of truth = the daemon's journal.** The UI renders journal state; it never holds it.

**macOS gotcha to validate early (Phase 0):** TCC Photos-library permission for a *background daemon* binary is fiddly — codesigning + entitlements + the consent prompt needs a user-facing trigger. Confirm the daemon (or a tiny helper invoked from the UI) can hold a durable Photos grant on a real Mac.

---

## 2. Data model — logical file → blob → frame → part

Four levels, each with a distinct job:

| Level | What | Why |
|---|---|---|
| **Logical file** | one user file/photo + metadata (path, EXIF, Live Photo pair, album, content hash) | what the user thinks they archived; the restore unit |
| **Blob** | concatenation of one-or-more files' encrypted frames = **one S3 object** | batching small files kills per-PUT + metadata overhead (§6.1, mandatory) |
| **Frame** | fixed plaintext chunk (recommend **4 MiB**), AEAD-sealed individually | the **integrity + encryption granularity**; bounds tamper detection |
| **Part** | S3 multipart part (recommend **64 MiB** = 16 frames) | the **upload + resume + ETag granularity** |

**Blob-sizing strategy (the one real batching tradeoff):**
- Small files → batched into blobs, **capped ~1–2 GB** per blob, and **grouped by locality** (same folder/album) so a folder-restore pulls few blobs.
- Large files → their own blob (no batching penalty).
- *Restore implication, and why it's fine:* to get one batched file you restore its whole blob — but Deep Archive **retrieval is $0.0025/GB** (a whole 1 GB blob ≈ ¼¢), and the expensive part, **egress, is ranged to just the file's bytes**. So over-retrieval from batching is economically negligible; we still keep blobs bounded for latency sanity.

---

## 3. The journal — durable, crash-safe state (the heart)

- **Store:** embedded **SQLite, WAL mode**, accessed via **GRDB** (type-safe Swift). Single file, transactional, battle-tested. This *is* the resumability guarantee.
- **Durability rule:** every state transition is a **committed transaction** (`fsync` on commit). A crash at *any* instant leaves a consistent, resumable state — never "uploaded but unrecorded" without reconciliation (§4 handles the window).
- **This journal is the metadata index SPOF (§6.6)** — back it up redundantly and treat corruption as the top risk. The authoritative record is written only *after* verification (§5).

**Schema sketch:**
```
sources(id, kind{folder|photos}, path/album_id, last_scanned, last_archived_at)
files(id, source_id, rel_path, size, mtime, content_sha256,
      status, blob_id, offset, length, plaintext_sha256,
      wrapped_dek_ref, first_frame_nonce, error)         -- status: discovered→planned→encrypting→uploading→verifying→archived | failed
blobs(id, s3_key, upload_id, storage_class, status,
      size, composite_sha256, created_at)                -- status: open→uploading→completed→verified | aborted
parts(blob_id, part_number, byte_lo, byte_hi, sha256, etag, status)  -- pending→uploaded→verified
```
File and part state machines are independent; the daemon advances both and the journal records every step.

---

## 4. Resume protocol — survive anything

On daemon start, and after every network outage/crash:

1. **Load journal.** Re-queue any `files` not `archived`.
2. **Reconcile in-flight blobs** (those with an `upload_id`): call **`ListParts`** against S3 and diff vs the journal. This closes the crash window — a part that uploaded but didn't get journaled (or vice versa) is reconciled against S3's truth. Skip parts that are `verified` *and* present; re-upload the rest.
3. **Deterministic part numbers** (by byte offset) make re-uploading a part **idempotent** — no double-writes, no corruption.
4. **Multipart uploads persist server-side** until completed/aborted, so a days-old `upload_id` is still resumable.
5. **Change detection on rescan:** key files by **content hash**, not just mtime → detect real edits, and **re-link moved/renamed files by hash** so we never re-upload unchanged bytes.

**Cost guardrail (verified):** in-progress Deep Archive multipart parts bill at **S3-Standard staging rates** until `CompleteMultipartUpload`. So: (a) complete promptly, (b) set an **S3 lifecycle rule to abort incomplete multipart uploads** after N days (recommend ~14 — long enough to resume a stalled multi-day sync, short enough to not bleed staging cost).

---

## 5. Integrity — end to end, the trust guarantee

1. **Plaintext fingerprint:** stream-hash each file's plaintext on read → `plaintext_sha256` in the journal. The "what we ingested" truth.
2. **Per-frame AEAD:** every 4 MiB frame is AES-256-GCM-sealed → its auth tag detects any corruption/tamper on the way back.
3. **Per-part SHA-256 to S3:** declare **`ChecksumAlgorithm = SHA256` at `CreateMultipartUpload`** (the gotcha — if you only pass it at Complete, S3 *accepts but doesn't store/validate* it). S3 then validates each part server-side on receipt and stores a **composite SHA-256** for the object.
4. **Completion check:** verify the composite checksum S3 returns matches what we computed.
5. **Verify-after:** `HeadObject` confirms existence/size/checksum metadata before we mark `archived`.
6. **Background "verify-the-bytes" audit (§6.6):** periodically restore a *small random sample* and check it against `plaintext_sha256`. We can't read Glacier for free, so day-to-day we lean on S3's 11-nines + the checksums S3 validated at ingest; the sampling audit catches systemic bugs.

**Only after step 5 does the authoritative file→blob→offset record commit to the index.** "Archived" means *verified present*, never just "PUT returned 200."

---

## 6. Encryption fit (V1 envelope; ZK-ready)

- **Per-blob data key (DEK)**, AES-256-GCM via **CryptoKit** (hardware-accelerated, native). Per-blob DEK bounds GCM nonce/birthday limits comfortably (a 500 GB archive is ~128k frames, far under safe bounds).
- DEK **wrapped by the user's key-encrypting-key (KEK)**; in V1 the **KEK is escrowed server-side** (§6.2). Wrapped DEK ref + per-frame nonce scheme stored in the journal/index.
- **ZK upgrade = stop escrowing the KEK → hand it to the user.** No format change — exactly the "key-handover, not a rewrite" the spec promises.
- Frames are encrypted **before** batching/upload; S3 only ever sees ciphertext blobs.

---

## 7. Throughput, backpressure, network

- **Bounded worker pool** for concurrent part uploads (start ~4–8, **adaptive** to measured throughput). Tunable.
- **Streaming pipeline** read→hash→encrypt→upload with **capped in-flight buffers** — never load 500 GB into memory; backpressure when the uploader lags the reader.
- **Newest/most-precious-first** ordering in the planner (recent + Photos favorites first) so *"your last 30 days are safe ✓"* lands in minutes (§6.3).
- **Network-aware retry:** classify transient vs permanent, exponential backoff + jitter, clean resume on reconnect; tolerate flaky home upstream.

---

## 8. Failure detection & observability (core, not deferred)

- **Per-source "last archived"** from the journal; **stall detection** (no progress in X min while work pending) → surfaced to UI + a macOS notification immediately (§6.4).
- **Moved/renamed/disconnected source** detection on rescan → re-prompt.
- Every error is **categorized and surfaced honestly** — no silent failure, ever (this is the catastrophe mode the whole product guards against).

---

## 9. IPC contract (daemon ↔ Electron)

- **Local Unix-domain socket**, JSON-RPC for commands + a server-push **event stream** for live progress.
- **Commands:** `addSource`, `removeSource`, `pause`, `resume`, `getStatus`, `requestRestore`, `getQuote`.
- **Events:** `progress` (per-source/per-file), `stalled`, `fileArchived`, `error`.
- Daemon authenticates the local client (peer-cred check); secrets live in **Keychain**, never in the UI.

---

## 10. Open decisions / recommendations

| Decision | Recommendation | Note |
|---|---|---|
| Frame size | **4 MiB** | integrity granularity; tune after Phase 0 upload test |
| Part size | **64 MiB** | fewer requests vs resume granularity |
| Blob cap | **~1–2 GB**, locality-grouped | balances PUT-cost vs restore latency |
| AEAD | **AES-256-GCM (CryptoKit)** | native + HW-accelerated; per-blob DEK |
| Journal | **SQLite/WAL via GRDB** | the resumability + SPOF store |
| Low-level multipart vs Transfer Manager | **Low-level** (`CreateMultipartUpload`/`UploadPart`/`Complete`) | Transfer Manager hides `uploadId`/ETags; we need them persisted for **cross-reboot** resume |
| Multipart abort lifecycle | **~14 days** | caps Deep Archive staging-cost bleed |

---

### TL;DR
A `launchd` Swift daemon owns ingest→encrypt→upload; Electron is a thin observer. **SQLite/WAL journal** makes it crash-safe-resumable; **`ListParts` reconciliation** closes the crash window; **deterministic part numbers** make retries idempotent. Integrity is layered: plaintext SHA-256 + per-frame AES-GCM tags + per-part SHA-256 validated by S3 (declared at `CreateMultipartUpload`) + verify-after + sampled byte-audits — and "archived" means *verified*, not "PUT 200." Files batch into locality-grouped ≤2 GB blobs of 4 MiB AEAD frames; per-blob DEK wrapped by an escrowed KEK (ZK = later key-handover, no rewrite). Newest-first ordering, bounded adaptive concurrency, honest stall detection. Uses GA AWS SDK for Swift, low-level multipart for journal-backed resume, with a lifecycle abort rule for the Glacier multipart staging-cost trap.
