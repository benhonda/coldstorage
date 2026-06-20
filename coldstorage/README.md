# ColdStorage daemon

The real foundation (supersedes the `phase0-*` spikes). A portable core does scan → plan → encrypt →
resumable multipart → verify → journal; the macOS adapter supplies PhotoKit behind one boundary. Built
to the four pillars: simple, best-practice, DRY, type-safe.

## Layout
```
Sources/ColdStorageCore/   # portable — builds/tests on Linux + macOS
  Models, IngestSource, LocalDirSource, Crypto, BlobPlanner, Journal, S3Store, UploadEngine
  DaemonService            # the run loop + command surface (registry-driven, wakeable, paused/running)
  EventBus, ControlProtocol, UnixSocket, ControlServer, ControlClient   # the unix-socket control plane
Sources/ColdStorageMac/    # macOS-only adapter (PhotoKitSource, FolderWatcher), canImport-guarded
Sources/coldstore-cli/     # portable runner — archive a dir to S3/MinIO from your container
Sources/coldstorectl/      # thin client over the daemon control socket (getStatus, addSource, watch, …)
Sources/coldstored/        # daemon entrypoint — wires engine + EventBus + ControlServer (+ FSEvents on Mac)
launchd/                   # com.theadpharm.coldstored.plist.template (LaunchAgent; task daemon:install)
Tests/                     # Core tests, run in CI on Linux
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
task daemon:ctl -- getStatus                 # counts, sources, paused/running
task daemon:ctl -- addSource path=/abs/dir   # register a source (persists in the journal; triggers a run)
task daemon:ctl -- triggerNow                # archive now instead of waiting the interval
swift run coldstorectl coldstored.sock watch # live event stream (runStarted/fileArchived/runFinished)
```
The **journal is the SSOT for sources** — add/remove via the socket survives restarts (`COLDSTORE_SOURCES`
is only a one-time seed). The socket is `0600` (owner-only). On macOS, `task daemon:install` renders the
LaunchAgent plist (RunAtLoad + KeepAlive) and bootstraps it; `daemon:uninstall` removes it.

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
MinIO (archive + resume + round-trip; IPC add/remove/trigger + restart persistence + live events). The
only off-Mac-unverified bit is the macOS adapter (`PhotoKitSource`, `FolderWatcher`) — guarded so the
portable build stays clean. `S3ClientConfiguration`/`*Input` deprecation warnings remain (SDK moved to
`S3ClientConfig`); a non-urgent cleanup.

## Known stubs / TODO (next build chunks)
- Glacier Deep Archive **thaw** (`RestoreObject`) before the restore GET — decrypt is proven, the thaw isn't wired.
- `PhotoKitSource`: real plaintext hashing pre-pass (currently keys on `localIdentifier`); `FolderWatcher` un-run off-Mac.
- Error handling: the loop now emits `error` events instead of crashing, but per-error classify/backoff/retry is TODO.
- Cross-blob concurrency + adaptive throughput (engine is correct sequential today).
- R2 thumbnail/browse index → Electron UI (a thin client over the control socket).
- Bucket lifecycle: abort-incomplete-multipart rule (Terraform).
