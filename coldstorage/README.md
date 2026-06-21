# ColdStorage daemon

The real foundation (supersedes the `phase0-*` spikes). A portable core does scan → plan → encrypt →
resumable multipart → verify → journal; the macOS adapter supplies PhotoKit behind one boundary. Built
to the four pillars: simple, best-practice, DRY, type-safe.

## Layout
```
Sources/ColdStorageCore/   # portable — builds/tests on Linux + macOS
  Models, IngestSource, LocalDirSource, Crypto, BlobPlanner, Journal, S3Store, UploadEngine, RestoreEngine
  DaemonService            # the run loop + command surface (registry-driven, wakeable, paused/running)
  EventBus, ControlProtocol, UnixSocket, ControlServer, ControlClient   # the unix-socket control plane
Sources/ColdStorageMac/    # macOS-only adapter (PhotoKitSource, FolderWatcher), canImport-guarded
Sources/coldstore-cli/     # portable runner — archive a dir to S3/MinIO from your container
Sources/coldstore-restore/ # get one file back — thaw (if Deep Archive) → ranged GET → decrypt → verify
Sources/coldstorectl/      # thin client over the daemon control socket (getStatus, addSource, watch, …)
Sources/coldstored/        # daemon entrypoint — wires engine + EventBus + ControlServer (+ FSEvents on Mac)
launchd/                   # com.theadpharm.coldstored.plist.template (LaunchAgent; task daemon:install)
Tests/                     # Core tests (swift-testing — NOT XCTest; XCTest deadlocks on Linux, see ROADMAP)
```

## Run the whole pipeline (native — no Docker, no Mac)
Driven from the **root Taskfile**. From the repo root:
```sh
task daemon:setup        # one-time: Swift toolchain + MinIO binaries (idempotent)
task daemon:minio        # start local MinIO + bucket
task daemon:testdata     # sample files (coldstorage/testdata)
task daemon:build        # first build fetches deps
task daemon:archive      # scan → encrypt → resumable multipart → verify
# Ctrl-C mid-run, re-run `task daemon:archive` → it resumes from S3's truth
task daemon:test         # portable Core tests
```
> MinIO console: http://localhost:9001 (minioadmin / minioadmin).

## Run it as the daemon + drive it over the control socket
```sh
task daemon:run                              # coldstored: scan loop + unix-socket control plane
task daemon:ctl -- getStatus                 # counts, sources, paused/running, permanentlyFailedBlobs
task daemon:ctl -- addSource path=/abs/dir   # register a source (persists in the journal; triggers a run)
task daemon:ctl -- triggerNow                # archive now instead of waiting the interval
task daemon:restore-ipc FILE=<fileId>        # restore over the socket (idempotent; re-run until state=restored)
swift run coldstorectl coldstored.sock watch # live event stream (runStarted/fileArchived/runFinished/blobFailed/restore*)
```
A failing blob is **isolated**, not fatal: the run continues, a `blobFailed{blob,kind,message}` event is
pushed, and a *permanent* fault (config/auth — e.g. `InvalidStorageClass`/`NoSuchBucket`) is skipped on
later passes (and counted in `getStatus.permanentlyFailedBlobs`) so the daemon doesn't re-stage a doomed
blob each interval. Transient faults are already retried by the AWS SDK before they reach us.
The **journal is the SSOT for sources** — add/remove via the socket survives restarts (`COLDSTORE_SOURCES`
is only a one-time seed). The socket is `0600` (owner-only). On macOS, `task daemon:install` renders the
LaunchAgent plist (RunAtLoad + KeepAlive) and bootstraps it; `daemon:uninstall` removes it.

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
round-trip-proven, but the live multi-hour `RestoreObject` retrieval needs real AWS to exercise. The other
off-Mac-unverified bit is the macOS adapter (`PhotoKitSource`, `FolderWatcher`) — guarded so the portable
build stays clean. `S3ClientConfiguration`/`*Input` deprecation warnings remain (SDK moved to
`S3ClientConfig`); a non-urgent cleanup.

## Known stubs / TODO (next build chunks)
- Live Deep Archive **thaw** leg — `RestoreObject` + hours-long retrieval is built but only exercisable on real AWS.
- Restore **over IPC** — `RestoreEngine.restore` is built; the daemon/UI just need a `requestRestore` command + event.
- `PhotoKitSource`: real plaintext hashing pre-pass (currently keys on `localIdentifier`); `FolderWatcher` un-run off-Mac.
- Error handling: the loop now emits `error` events instead of crashing, but per-error classify/backoff/retry is TODO.
- Cross-blob concurrency + adaptive throughput (engine is correct sequential today).
- R2 thumbnail/browse index → Electron UI (a thin client over the control socket).
- Bucket lifecycle: abort-incomplete-multipart rule (Terraform).
