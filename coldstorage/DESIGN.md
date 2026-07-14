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
  Crypto (envelope, AEAD frames) · BlobPlanner · models/state machines · the control plane. Covered by the
  Swift test suite (`task daemon:test`) against in-process fakes — including a full archive→restore round
  trip, resume-skips-landed-parts, the drift guard, and the streaming memory bounds. No server, no network,
  runs on Linux/CI. ~80% of the hard logic lives here.
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
- **Single source of truth = the signed-in user's journal.** The UI renders journal state; it never
  holds it.

### The session — the daemon acts as exactly one user, or none

`UserSession` (`ColdStorageCore/UserSession.swift`) owns **all** per-user state: the journal, the
scratch dir, `status.json`, the MasterKey holder (`SwappableKeyProvider`), the `VaultPrefix`, and both
engines. `DaemonService` holds a single `private var session: UserSession?` and nothing unscoped.

- **Built at `authenticate`, destroyed at `deauthenticate`.** A session is never re-pointed at another
  user; a different Cognito `sub` means the old session is torn down (key cleared) and a new one built.
  Re-authenticating the *same* `sub` (the app's hourly token refresh) keeps the session, so an unlocked
  MasterKey and an in-flight upload survive it.
- **Signed out ⇒ nothing to serve.** Reads (`getStatus`/`listFiles`/`listSources`/`listExcludes`)
  return the empty answer; every mutation throws *"not signed in"*. Not because each path remembers to
  filter — because there is no unscoped journal to reach for. *(This is the fix for the 2026-07-13
  cross-account leak: a machine-wide journal with no owner column showed account B account A's whole
  file tree, folder paths, sizes and watched-folder registry after a sign-out/sign-in on one Mac. File
  **bytes** never crossed — IAM scopes S3 per identity, MasterKeys are escrowed per `sub` — but the
  index did.)*
- **Identity is stated, never inferred.** `coldstored` requires Cognito to be configured, and refuses to
  start (`exit 2`) without it. There is no "no auth configured" fallback: that mode signed every S3 call as
  the shared all-access IAM user against a shared key prefix. *(A `COLDSTORE_DEV_IDENTITY` sandbox mode also
  lived here, for the local MinIO loop. Both were retired 2026-07-14 — MinIO proved nothing the test suite
  doesn't prove deterministically, and a second identity path into a security-sensitive daemon is not
  something to carry for a convenience.)*
- **`VaultPrefix`** (`VaultPrefix.swift`) is the only way to spell a user's S3 namespace:
  `.key(for: blobId)` (no trailing slash) vs `.listing` (**with** the trailing slash, which
  `ListObjectsV2` and the IAM `s3:prefix` condition `blobs/<sub>/*` both require). A bare
  `blobs/<identityId>` string passed to the usage listing is what made every quota read `AccessDenied`
  — so the slash is settled by the type, once, and never again at a call site.

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

## 4. The journal — per-user, durable, crash-safe (the heart)

- **One journal per user, not per machine.** Per-user state lives under a data **root**
  (`COLDSTORE_DATA_DIR`), keyed by the Cognito **user-pool `sub`** — the canonical identity (the
  identity-pool `identityId` is a derived S3-addressing detail, and names the vault prefix only):
  ```
  <dataRoot>/users/<sub>/coldstore.sqlite   # journal: file index, watched-folder registry, excludes
  <dataRoot>/users/<sub>/scratch/           # PUSH-source landing zone (a Photos asset mid-stream) — plaintext
  <dataRoot>/users/<sub>/status.json        # run summary this user's app reads
  <dataRoot>/coldstored.sock                # the ONE machine-level file (COLDSTORE_SOCKET)
  ```
  A local-dev identity gets the same layout at `users/dev-<name>/`, so dev exercises the real path.
  Nothing is opened at process start — at launch nobody is signed in yet.
- **Plaintext is streamed, never buffered — memory tracks the chunk, not the file.** `IngestItem.open()`
  must yield bytes with real backpressure. The obvious `AsyncThrowingStream { cont in … cont.yield(chunk) }`
  does the opposite: it runs its producer **synchronously at construction**, its default buffering policy is
  **`.unbounded`**, and `yield` never suspends — so the whole file lands in RAM before the consumer asks for
  byte one (measured: a 256 MiB file → 391 MiB of RSS). That, not disk, is what killed a 1k-file deposit on
  2026-07-14. `ByteStreams.swift` holds the two sanctioned shapes: `pullStream(of:)` for a source we can read
  on demand (a file — zero buffering, zero disk), and `scratchFileStream(at:write:)` for one that PUSHES at
  its own pace (PhotoKit — drained to a per-user scratch file at full speed, then pulled back at upload pace,
  which also decouples an iCloud download from a multi-hour S3 upload). **Never bound such a stream with
  `bufferingPolicy:`** — every bounded policy DROPS elements, and dropping file bytes is corruption, not
  throttling. `StreamBackpressureTests` pins this to a number, because every functional test passes while it
  is broken; it is why `daemon:test` runs `--no-parallel`.
- **The upload engine writes NOTHING to disk — it encrypts straight into the multipart upload.** It used to
  encrypt each blob into a staging file and then upload that file part by part, which cost a full second copy
  of every byte: a 40 GB video demanded 40 GB of free space, and a backup tool that needs as much headroom as
  the file it is saving fails exactly the user who most needs it. Staging bought nothing that justified it —
  resume never read those bytes back (a resumed blob re-reads and re-encrypts from the source regardless,
  because the journal's stored DEK + nonce prefix make the ciphertext deterministic, so re-encrypting
  reproduces the parts already on S3 byte for byte), it delayed the first byte of upload until the whole blob
  was encrypted, and a killed run stranded it on disk forever. Now: source → 4 MiB frame → 64 MiB part → S3,
  with only the part in flight held in memory (`PartShipper`). Peak disk for a file deposit is **zero**,
  whatever the file's size.
- **The one thing still written to disk is a PUSH source.** PhotoKit hands us bytes at its own pace and cannot
  be told to wait, so an asset is drained to `scratch/` at full speed and pulled back at upload pace
  (`scratchFileStream`). That costs one plaintext copy of the asset — deliberately, because the alternative is
  throttling an iCloud download to the speed of a multi-hour S3 upload. `sweepScratch` empties the dir when a
  session is built, so a killed deposit can't strand a full-size copy of someone's video forever.
- **A source that changed since the scan is REJECTED, not archived.** `archive` re-computes the plaintext
  SHA-256 as it encrypts and checks it against the item's `ContentKey`: `.sha256` for a file (hashed during
  the walk, so it CAN be checked) and `.opaque` for a Photos asset (an identity — its bytes don't exist until
  PhotoKit streams them, so there is nothing to check). One sum type rather than a hash plus a nullable
  hash-of-the-hash, so a source cannot state a plan key and a verifiable hash that disagree. Without this,
  a file edited mid-upload, or a resumed blob whose source changed since the scan, uploads a mix of old and
  new bytes that **passes every downstream check** — `verify` is only a HEAD — and gets marked archived. The
  corruption then surfaces at RESTORE, which is the worst possible moment for a backup product to discover
  it. A drifted blob fails `permanent`ly and correctly so: its id is derived from the OLD content hash, so
  that blob can never be archived again — the next scan re-hashes the file and plans it afresh under a new id.
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
  listExcludes · addSource · removeSource · addExclude · removeExclude · restorePlan · restore ·
  deposit · depositPhotos · previewDeposit · movePath · createFolder · deletePath · authenticate ·
  deauthenticate · mintVault · unlockVault · unlockVaultWithRecoveryCode · lockVault · triggerNow ·
  pauseSource · resumeSource`.
- **Events — SSOT is the `DaemonEvent(...)` call sites:** `runStarted · fileArchived · uploadProgress ·
  runFinished · blobFailed · sourcesChanged · filesChanged · excludesChanged · restoreRequested ·
  restoreInProgress · restoreCompleted · restoreNeedsAuthorization · error`.
- **Every command is session-scoped** (§2): signed out, the four reads answer empty and everything else
  throws *"not signed in"*. `getStatus` says so explicitly — `signedIn: bool` — and its `bytesStored`
  (the S3-derived storage-quota usage figure) is non-null whenever signed in, `null` only when not.
- Semantics worth knowing: `movePath {from,to}` is the single primitive behind move AND rename (a
  journal `relativePath` prefix-sweep — no S3, no thaw, stable `id` preserved); `deletePath`
  tombstones (`status=deleted`, rows kept for a deferred repack/GC); `filesChanged` carries
  `{moved,to}` / `{created}` / `{deleted}` — plus `{signedIn}` / `{signedOut}`, the cue that the whole
  tree just changed owner; `authenticate idToken=…` / `deauthenticate` open and close the session
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
| Per-user state | **`<dataRoot>/users/<sub>/`**, owned by a `UserSession` | one journal/scratch/status per account, never machine-wide |
| S3 namespace | **`VaultPrefix`** (`blobs/<identityId>`) | typed: keys unslashed, listings slashed — the IAM `s3:prefix` condition needs the slash |
| Multipart | **Low-level** (`CreateMultipartUpload`/`UploadPart`/`Complete`) | Transfer Manager hides `uploadId`/ETags; we persist them for cross-reboot resume |
| Abort lifecycle | **14 days** | caps the Deep Archive staging-cost bleed |

### TL;DR
A launchd Swift daemon owns ingest→encrypt→upload; Electron is a thin observer. It acts as exactly one
signed-in user at a time — a `UserSession` (journal, scratch, status, key, prefix) built at sign-in and
destroyed at sign-out, so signed out there is nothing to serve. SQLite/WAL journal +
`ListParts` reconciliation + deterministic parts = crash-safe idempotent resume. Integrity is layered
(plaintext SHA-256, per-frame GCM tags, per-part SHA-256 validated by S3, verify-after) and "archived"
means verified. Locality-grouped ≤2 GB blobs of 4 MiB AEAD frames; per-blob DEK under a KEK that the
ZK master-key hierarchy (built, wiring pending — PROD.md) will hand to the user without a format change.

- **Empty files and empty blobs are archived, not failed.** A zero-byte file has no ciphertext, so its span is
  `length: 0`; `RestoreEngine` short-circuits rather than asking S3 for `bytes=N-(N-1)` (backwards → 416, so
  the file used to be archived-but-unrecoverable). A blob whose items are ALL empty produces no parts at all —
  S3 has no zero-byte multipart upload and rejects `complete` with an empty part list, which we classify as
  permanent — so the multipart upload is opened **lazily, on the first part with bytes**: no bytes, no upload,
  nothing to dangle, and the files still link. A directory of `.gitkeep`s is not a failure.
- **A part is skipped on resume only when S3 AND the journal agree it landed.** `ListParts` says what S3 holds;
  `complete` is fed from the journal. `uploadPart` can return and the process die before the row commits — one
  window per part — and `CompleteMultipartUpload` assembles ONLY the parts it is handed, so trusting S3 alone
  silently produced an object 64 MiB short with every later byte shifted, past a `verify` that is just a HEAD.
