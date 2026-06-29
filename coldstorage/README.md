# ColdStorage daemon

The real foundation (supersedes the `phase0-*` spikes). A portable core does scan → plan → encrypt →
resumable multipart → verify → journal; the macOS adapter supplies PhotoKit behind one boundary. Built
to the four pillars: simple, best-practice, DRY, type-safe.

## Layout
```
Sources/ColdStorageCore/   # portable — builds/tests on Linux + macOS
  Models, IngestSource, LocalDirSource, Crypto, BlobPlanner, Journal, S3Store, UploadEngine, RestoreEngine
  ExplicitPathsSource, PhotoResolver/PhotoDepositSource   # ad-hoc deposit sources (files / picked photos)
  DaemonService            # the run loop + command surface (registry-driven, wakeable, paused/running)
  EventBus, ControlProtocol, UnixSocket, ControlServer, ControlClient   # the unix-socket control plane
Sources/ColdStorageMac/    # macOS-only adapter (PhotoKitSource + PhotoKitResolver, FolderWatcher), canImport-guarded
Sources/coldstore-cli/     # portable runner — archive a dir to S3/MinIO from your container
Sources/coldstore-restore/ # get one file back — thaw (if Deep Archive) → ranged GET → decrypt → verify
Sources/coldstorectl/      # thin client over the daemon control socket (getStatus, addSource, watch, …)
Sources/coldstore-photo-picker/  # macOS native PHPickerViewController helper → prints picked {id,name} (option B)
Sources/coldstored/        # daemon entrypoint — wires engine + EventBus + ControlServer (+ FSEvents on Mac)
launchd/                   # plist template + coldstored-Info.plist (TCC identity for Photos); task daemon:install
Tests/                     # Core tests (swift-testing — NOT XCTest; XCTest deadlocks on Linux, see ROADMAP)
```

## Run the whole pipeline (native — no Docker, no Mac)
Driven from the **root Taskfile**. From the repo root:
```sh
task daemon:setup        # one-time: Swift toolchain + MinIO binaries (idempotent)
task daemon:minio        # start local MinIO + bucket
task daemon:testdata     # sample files (coldstorage/testdata)
task daemon:build:dev    # debug build for the dev loop; first build fetches deps
task daemon:archive      # scan → encrypt → resumable multipart → verify
# Ctrl-C mid-run, re-run `task daemon:archive` → it resumes from S3's truth
task daemon:test         # portable Core tests
```
> MinIO console: http://localhost:9001 (minioadmin / minioadmin).

## Run it as the daemon + drive it over the control socket
```sh
task daemon:run                              # coldstored: scan loop + unix-socket control plane
task daemon:ctl -- getStatus                 # counts, sources, paused/running, permanentlyFailedBlobs
task daemon:ctl -- listFiles                 # the browsable tree from the journal (id/relativePath/size/status/blobId)
task daemon:ctl -- addSource path=/abs/dir   # register a WATCHED source (persists in the journal; triggers a run)
task daemon:deposit-ipc SRC=/abs/path DEST=folder  # ad-hoc one-shot upload (no watched source); the UI's drag-drop
task daemon:move-ipc FROM=a/x.jpg TO=b/x.jpg # reorganize: file/folder MOVE or RENAME (journal relativePath edit)
task daemon:delete-ipc PATH=b/x.jpg          # delete (tombstone) a file/folder subtree; drops from listFiles
task daemon:ctl -- triggerNow                # archive now instead of waiting the interval
task daemon:restore-ipc FILE=<fileId>        # restore over the socket (idempotent; re-run until state=restored)
swift run coldstorectl coldstored.sock watch # live event stream (runStarted/fileArchived/runFinished/blobFailed/filesChanged/restore*)
```
A failing blob is **isolated**, not fatal: the run continues, a `blobFailed{blob,kind,message,paths}` event
is pushed (`paths` = newline-joined relativePaths of the files in the blob), and a *permanent* fault
(config/auth — e.g. `InvalidStorageClass`/`NoSuchBucket`) is skipped on later passes (and counted in
`getStatus.permanentlyFailedBlobs`) so the daemon doesn't re-stage a doomed blob each interval. A permanent
fault also marks its files `failed` in the journal (`Journal.markFilesFailed`), so `listFiles` returns
`failed` and the UI's ⚠ survives a refresh/restart. Transient faults are already retried by the AWS SDK
before they reach us.
The **journal is the SSOT for sources** — add/remove via the socket survives restarts (`COLDSTORE_SOURCES`
is only a one-time seed). The socket is `0600` (owner-only). On macOS the full setup is two task runs:
`task tf:coldstorage:creds-export` (in the devcontainer — TF creds → a gitignored handoff file over the bind
mount) then `task daemon:bootstrap` (seeds the AWS secret into the login Keychain + wires a `coldstorage`
profile whose `credential_process` reads it, then renders the LaunchAgent plist (RunAtLoad + KeepAlive) and
bootstraps it). `task daemon:doctor` health-checks it; `daemon:uninstall` removes it. AWS creds resolve via
the Keychain — never a plaintext file — and the `credential_process` helper lives at a space-free
`~/.coldstorage/` (AWS splits that command on whitespace).

The server runs each command's async handler **off** the connection's read thread (no semaphore bridge —
that was a forward-progress hazard); writes per connection are serialized. Client API: `ControlClient(path:
readTimeout:)` — pass a `readTimeout` (seconds) for request/response calls so a stalled daemon fails fast;
omit it for a live event tail (`watch`), which blocks indefinitely by design. A UI is just a long-lived
`ControlClient`. **Non-Swift clients** (the Electron UI) speak the same JSONL protocol directly over the
socket — `ControlProtocol.swift` is the wire contract; see [`../ELECTRON-UI-DESIGN.md`](../ELECTRON-UI-DESIGN.md).

## Get a file back (restore)
```sh
task daemon:restore FILE=<fileId> OUT=/tmp/got.bin     # standalone (coldstore-restore); fileId = the relative path shown at archive time
task daemon:restore-ipc FILE=<fileId> OUT=/tmp/got.bin # same, but driven over a running daemon's control socket
```
Two front-ends, one engine (`RestoreEngine`): the standalone `coldstore-restore` binary, and the daemon's
`restore` control command (so the UI restores over the same socket it watches). Both are idempotent — re-run
until the bytes land. Over IPC the response carries `state` (`restored` | `thawRequested` | `thawInProgress`)
plus the quoted `typicalWait` while thawing, and a `restore*` event is pushed to live watchers.
Restore is **idempotent and self-progressing** — re-run the same command until it lands:
- **STANDARD/MinIO** (and `GLACIER_IR`): downloads, decrypts, hash-verifies, writes → exit `0`.
- **Deep Archive**: the first run issues a Glacier **thaw** (`RestoreObject`) and exits `75` (`EX_TEMPFAIL`);
  retrieval takes ~12 h (`--tier standard`) or ~48 h (`--tier bulk`). Re-run later → it downloads once ready.

`RestoreEngine.restore` returns `.restored / .thawRequested / .thawInProgress`; the thaw decision (`ThawState`)
reads the object's real storage class + `x-amz-restore` header from `HeadObject`, so it's correct regardless
of how we stored it. The decision logic is unit-tested (`ThawStateTests`); the live Deep Archive thaw can only
be exercised against real AWS (MinIO serves directly).

## How robustness works (the crown jewel)
- **Deterministic encryption** — per-blob DEK + AES-GCM frames with counter nonces → a sealed blob is
  byte-reproducible, so re-staging on resume yields identical parts whose ETags match what's already up.
- **Journal (SQLite/WAL)** — every part/blob/file transition committed; a crash leaves a resumable state.
- **`ListParts` reconcile** — S3 is the truth on restart; done parts are skipped.
- **Layered integrity** — plaintext SHA-256 per file + per-part SHA-256 declared at `CreateMultipartUpload`
  (so S3 stores/validates) + `HeadObject` verify. "Archived" = verified, never "PUT 200".
- **Newest/most-precious-first** planning so recent + favorites land fast.

## Status
Builds and tests green on Linux (swiftly); the engine **and** control plane are proven end-to-end against
MinIO (archive + resume + round-trip restore; IPC add/remove/trigger + restart persistence + live events).
The restore path is now **thaw-aware** — Deep Archive thaw logic is unit-tested, the download/decrypt leg is
round-trip-proven, but the live multi-hour `RestoreObject` retrieval needs real AWS to exercise. The macOS
adapter (`PhotoKitSource`, `FolderWatcher`) now **compiles + the daemon runs on macOS** (2026-06-21, control
socket up, Electron UI connected). **PhotoKit mechanics are PROVEN** (2026-06-26, `phase0-photos-spike` on a
real Mac — durable Photos TCC grant under launchd + full-res iCloud original). **But photos are now
EXPLICIT-deposit only, never auto-watched** (product decision 2026-06-26): the daemon's old
`COLDSTORE_PHOTOS=1` enumerate-everything path is **removed** (`platformSources` is empty); the explicit
photo-deposit path is **built + proven end-to-end on a real Mac (2026-06-26)** — native PHPicker helper →
`depositPhotos` → daemon archives full-res originals (see ROADMAP). **`FolderWatcher` FSEvents behavior is now PROVEN on a real Mac (2026-06-26)** — a drop fires a sub-second re-scan under a 600s poll (`task daemon:fsevents-test`). The watcher is now **re-armable** (`FolderWatcher.setPaths` + `main.swift` subscribes to `sourcesChanged`), so `addSource`'d/unpaused folders are watched without a daemon restart (**proven on a real Mac 2026-06-26** — a drop into a folder added post-startup fired a sub-second re-scan, no restart).
`S3ClientConfiguration`/`*Input` deprecation warnings remain (SDK moved to `S3ClientConfig`); a non-urgent cleanup.

## Known stubs / TODO (next build chunks)
- ~~Live Deep Archive **thaw** leg~~ — **DONE ✅ (2026-06-27): PROVEN END-TO-END on the real prod vault.** First REAL thaw was requested + AWS-confirmed 2026-06-26 (`restore` → `state=thawRequested`; `head-object` `ongoing-request="true"`); after the ~12h Standard clock a single re-run returned `state=restored` with a verified file written (`RestoreEngine` won't write on hash mismatch, so that *is* the byte-identical proof). No longer a stub — the whole pipeline has zero unproven legs vs real AWS. `task daemon:restore-wait` remains the hands-off poller for future thaws. See ROADMAP.
- **UI contract gaps** (the Electron panel needs these — see [`../ELECTRON-UI-DESIGN.md`](../ELECTRON-UI-DESIGN.md) "Daemon contract gaps"):
  - **`newFolder`** (a virtual path, still local-only); a per-run **filesFailed** count (blobs ≠ files); **skipped-count reporting** (how many files the excludes filtered). *(`move`/`rename`/`delete` landed as `movePath`/`deletePath`; **exclude get/set**, the **restore fee** estimate, and **bytes/size** all landed too — see below.)*
- **Explicit photo-deposit path — DONE ✅ + proven on a real Mac (2026-06-26):** native PHPicker helper (`coldstore-photo-picker`) → `depositPhotos` → daemon resolves picked ids via `PhotoKitResolver` + archives full-res originals; `coldstored-Info.plist` embedded (`-sectcreate`) + codesigned `--identifier`-pinned in `task daemon:install`. *Remaining TODO in this area:* real plaintext hashing pre-pass for photos (the `contentHash` metadata still keys on `localIdentifier` — integrity is unaffected, it's computed from real bytes at archive time, but a real hash would dedup re-deposits better). *(FSEvents `FolderWatcher` — incl. live re-arm on `sourcesChanged` — is now PROVEN on a real Mac, 2026-06-26; was listed here as untested.)*
- Cross-blob concurrency + adaptive throughput (engine is correct sequential today); persistent poison-blob state (skip-list is in-memory).
- R2 bucket for photo **thumbnails** + cross-device index portability (the browse *tree* is journal-backed and needs no R2).

> **Done since earlier drafts (no longer stubs):** restore **over IPC** (`restore` command + `restore*` events, byte-identical vs MinIO) · **graceful error handling** (`FailureKind` classify + per-blob isolation + skip-list; SDK owns transient retry) · **`listFiles`** (journal-backed browse tree) · ad-hoc **`deposit`** (drop-to-upload, `ExplicitPathsSource`) · **`movePath` / `deletePath`** (reorganize move/rename via a journal `relativePath` prefix-sweep + delete-as-tombstone; `filesChanged` event, proven vs MinIO) · **`uploadProgress` event** (per-file determinate bar for solo-blob large files; `UploadProgress` struct + `onProgress` callback, proven vs MinIO) · **per-file `failed` status** (`Journal.markFilesFailed` on permanent faults + `paths` on `blobFailed` → ⚠ row that's journal truth) · **scan excludes** (`listExcludes`/`addExclude`/`removeExclude` + `excludesChanged`; journal `excludes` table, defaults seeded once; `ExcludeMatcher` applied *inside* the `LocalDirSource` walk so junk like node_modules is pruned before hashing, proven vs MinIO) · **`getPricing`** (storage/retrieval rate-card SSOT — `Pricing` + `RestoreTier.retrievalUsdPerGB` — the UI quotes fee/cost from it; bytes/size stay journal-derived in the renderer, no `Status` field) · bucket **lifecycle** (abort-incomplete-multipart, applied) · the **Electron UI** (My Files + Settings, wired to the daemon).
