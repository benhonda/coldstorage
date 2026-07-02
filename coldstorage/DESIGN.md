# ColdStorage daemon — design

> The design in force for `coldstored` and the engine underneath it (merged from the original
> `UPLOAD-DAEMON-DESIGN.md` + `daemon-module-split.md` root docs, 2026-07-02 — updated to as-built).
> The upload path is the crown jewel: resumable through anything, integrity-checked end to end,
> observable. The Electron/React app is only a control panel talking to the daemon over local IPC.
> What exists + how to run it: [`README.md`](./README.md). The multi-user/ZK/billing layer: [`../PROD.md`](../PROD.md).

---

## 1. Module split — portable core / Mac adapter

One boundary protocol separates a **portable core** from a thin **macOS adapter**. The core never
imports an Apple-only framework, so it builds and tests on Linux (the devcontainer / CI); the Mac
supplies the genuinely platform-bound seam.

- **Core (container/CI):** UploadEngine (multipart, resume, concurrency, retry) · Journal (SQLite/WAL) ·
  Crypto (envelope, AEAD frames) · BlobPlanner · models/state machines · the control plane. Tested
  against MinIO — fast, offline, scriptable kills/failures. ~80% of the hard logic lives here.
- **macOS adapter:** PhotoKit ingest, FSEvents folder watch, TCC/permissions, Keychain, launchd glue,
  codesign/notarize.
- **The boundary:** `IngestSource` (`enumerate() → [IngestItem]`, each item an openable stream +
  content hash + metadata). macOS implements it with PhotoKit/FSEvents sources; Linux tests implement
  it from plain directories, so the whole pipeline (scan → batch → encrypt → resumable multipart →
  journal) runs end-to-end without a Mac.

Target layout (what lives where, how to gate the Mac target): [`README.md`](./README.md) § Layout.

## 2. Processes & lifecycle

- **`coldstored`** — does all the real work. Runs as a **launchd LaunchAgent** (per-user,
  `RunAtLoad` + `KeepAlive`). LaunchAgent, not LaunchDaemon, because it must run in the user session to
  reach the Photos library (TCC) and Keychain. *(The "can a background daemon hold a durable Photos
  grant?" risk was proven out 2026-06-26 — signed binary + embedded Info.plist; see the README's
  Status section and `phase0-photos-spike/`.)*
- **Electron/React app** — a control panel + observer. Owns no upload state; connects over a local
  Unix-domain socket (JSONL + an event stream). Can be closed/crashed/reopened freely.
- **Single source of truth = the daemon's journal.** The UI renders journal state; it never holds it.

## 3. Data model — logical file → blob → frame → part

| Level | What | Why |
|---|---|---|
| **Logical file** | one user file/photo + metadata (path, EXIF, content hash) | what the user thinks they archived; the restore unit |
| **Blob** | one-or-more files' encrypted frames = **one S3 object** | batching small files kills per-PUT + metadata overhead |
| **Frame** | fixed 4 MiB plaintext chunk, AEAD-sealed individually | the **integrity + encryption granularity** |
| **Part** | S3 multipart part (64 MiB = 16 frames) | the **upload + resume + ETag granularity** |

**Blob sizing:** small files batch into blobs **capped ~1–2 GB**, grouped by locality (same
folder/album) so a folder-restore pulls few blobs; large files get their own blob. Over-retrieval from
batching is economically negligible (Deep Archive retrieval is $0.0025/GB and egress is ranged to the
file's bytes) — blobs stay bounded for latency sanity, not cost.

## 4. The journal — durable, crash-safe state (the heart)

- **Store:** embedded **SQLite, WAL mode**, via **`libsqlite3` directly** (the `Csqlite3` system module
  + a thin typed wrapper in `Journal.swift` — GRDB was the original sketch; the dep surface was kept
  minimal instead). This *is* the resumability guarantee.
- **Durability rule:** every state transition is a committed transaction. A crash at any instant leaves
  a consistent, resumable state; the §5 reconcile closes the "uploaded but unrecorded" window.
- **The journal is the metadata-index SPOF** — losing it makes the opaque-ciphertext archive
  unrecoverable. First-class durability (hot, versioned, replicated) + a cross-device story is the
  R2/portability work, load-bearing for multi-user (see `../PROD.md`).
- Schema SSOT is `Journal.swift` (`sources` / `files` / `blobs` / `parts` / `excludes`); file and part
  state machines are independent.

## 5. Resume protocol — survive anything

On daemon start and after every outage/crash:

1. **Load journal**; re-queue any files not `archived`.
2. **Reconcile in-flight blobs** via **`ListParts`** against S3 — S3 is the truth for the crash window;
   verified-and-present parts are skipped, the rest re-upload.
3. **Deterministic part numbers** (by byte offset) + deterministic encryption make re-uploads
   idempotent — no double-writes, no corruption.
4. Multipart uploads persist server-side, so a days-old `uploadId` is still resumable.
5. **Change detection on rescan** keys on **content hash**, not just mtime — real edits detected,
   moved/renamed files re-linked by hash, unchanged bytes never re-uploaded.

**Cost guardrail:** in-progress Deep Archive multipart parts bill at S3-Standard staging rates until
completed — so complete promptly, and the bucket has a **lifecycle rule aborting incomplete multipart
uploads after 14 days** (applied, `infra/coldstorage`).

## 6. Integrity — end to end

1. Stream-hash each file's plaintext on read → `plaintext_sha256` in the journal.
2. Every 4 MiB frame is AES-256-GCM-sealed → auth tag catches corruption/tamper on the way back.
3. **Per-part SHA-256 declared at `CreateMultipartUpload`** (the gotcha: declared only at Complete, S3
   accepts but doesn't store/validate) → S3 validates each part server-side + stores a composite.
4. Completion check: S3's composite checksum must match ours.
5. `HeadObject` verify-after before anything is marked `archived`.
6. Background sampling audit (restore a small random sample, check against `plaintext_sha256`) — the
   deferred systemic-bug catcher.

**"Archived" means *verified present*, never "PUT returned 200."** Restore hash-verifies before
writing, so a restored file is byte-identical by construction.

## 7. Encryption — envelope, ZK-ready

- **Per-blob DEK**, AES-256-GCM via CryptoKit; frames encrypted before batching/upload — S3 only ever
  sees ciphertext.
- DEK wrapped by the user's KEK (`KeyProvider.userKEK()`); wrapped-DEK ref + nonce scheme in the journal.
- **The ZK upgrade is a key-handover, not a rewrite — and its primitives are now built** (2026-07-01):
  `ZeroKnowledgeKeys.swift` puts a random per-user MasterKey behind two Argon2id unlock paths
  (password, one-time recovery code); the MK *is* the `userKEK()` the engine already expects, so
  engine/cipher code is untouched. Wiring into `coldstored` lands with the account backend + auth UX —
  design + status in [`../PROD.md`](../PROD.md) Phase 3.

## 8. Throughput, backpressure, network

- Bounded worker pool for concurrent part uploads; streaming read→hash→encrypt→upload with capped
  in-flight buffers — never load an archive into memory.
- **Newest/most-precious-first** planning so recent files land in minutes.
- Transient retry is the **AWS SDK's** job (built-in backoff); our layer classifies failures
  (`Failure.swift`, permanent vs transient) and isolates per blob — a poison blob is surfaced and the
  run continues. **Cross-blob concurrency is deferred** until there's a real-AWS bench to measure
  against (correctness before speed — a decision in force).

## 9. Failure detection & observability

- Per-source "last archived" + stall detection surfaced to the UI immediately.
- Every error is categorized and surfaced honestly — **no silent failure, ever** (that's the
  catastrophe mode the product guards against). Permanent blob failures mark their files `failed` in
  the journal and go on a skip list (in-memory today; persisting it needs a schema change, deferred).

## 10. IPC contract (daemon ↔ Electron)

Local Unix-domain socket (`0600`), newline-delimited JSON commands + a server-push event stream.
Secrets live in Keychain, never in the UI.

- **Commands — SSOT is `DaemonService.handle`:** `ping · getStatus · listSources · listFiles ·
  getPricing · listExcludes · addSource · removeSource · addExclude · removeExclude · restore ·
  deposit · depositPhotos · previewDeposit · movePath · createFolder · deletePath · authenticate ·
  triggerNow · pauseSource · resumeSource`.
- **Events — SSOT is the `DaemonEvent(...)` call sites:** `runStarted · fileArchived · uploadProgress ·
  runFinished · blobFailed · sourcesChanged · filesChanged · excludesChanged ·
  restoreRequested · restoreInProgress · restoreCompleted · error`.
- Semantics worth knowing: `movePath {from,to}` is the single primitive behind move AND rename (a
  journal `relativePath` prefix-sweep — no S3, no thaw, stable `id` preserved); `deletePath`
  tombstones (`status=deleted`, rows kept for a deferred repack/GC); `filesChanged` carries
  `{moved,to}` / `{created}` / `{deleted}`; `authenticate idToken=…` is the Cognito seam
  (`../PROD.md` Phase 2); per-source pause lives on the source rows (`pauseSource`/`resumeSource` emit
  `sourcesChanged` — there are no global pause events).

## 11. Decisions (as built)

| Decision | Choice | Note |
|---|---|---|
| Frame size | **4 MiB** | integrity granularity |
| Part size | **64 MiB** | requests vs resume granularity |
| Blob cap | **~1–2 GB**, locality-grouped | PUT-cost vs restore latency |
| AEAD | **AES-256-GCM (CryptoKit)** | native + HW-accelerated; per-blob DEK |
| Journal | **SQLite/WAL via libsqlite3 directly** | the resumability + SPOF store |
| Multipart | **Low-level** (`CreateMultipartUpload`/`UploadPart`/`Complete`) | Transfer Manager hides `uploadId`/ETags; we persist them for cross-reboot resume |
| Abort lifecycle | **14 days** | caps the Deep Archive staging-cost bleed |

### TL;DR
A launchd Swift daemon owns ingest→encrypt→upload; Electron is a thin observer. SQLite/WAL journal +
`ListParts` reconciliation + deterministic parts = crash-safe idempotent resume. Integrity is layered
(plaintext SHA-256, per-frame GCM tags, per-part SHA-256 validated by S3, verify-after) and "archived"
means verified. Locality-grouped ≤2 GB blobs of 4 MiB AEAD frames; per-blob DEK under a KEK that the
ZK master-key hierarchy (built, wiring pending — PROD.md) will hand to the user without a format change.
