# Changelog

## 2026-06-21

- feat: daemon AWS-cred wiring — `task tf:coldstorage:creds-export` (container) writes a gitignored `coldstorage/.local/daemon-creds.env` handoff; macOS `task daemon:bootstrap` (`daemon:creds`→`daemon:install`) seeds the secret into the login Keychain + wires a `coldstorage` profile (`credential_process` helper at space-free `~/.coldstorage/`), plist gains `AWS_PROFILE`/`__PROFILE__`; `task daemon:doctor` health-checks launchd+auth+`getStatus`.
- docs: ROADMAP — `infra/coldstorage` Terragrunt scaffolded, `validate`-clean, and APPLIED vs real AWS (`9 add`); prod GDA S3 vault + least-priv daemon IAM user live. Remaining: wire daemon launchd env from TF outputs; R2 deferred.
- fix: first macOS daemon run — `PhotoKitSource` Sendable-capture fix (re-resolves `PHAssetResource` off-thread by id), `LocalDirSource` drains via `nextObject()` (NSEnumerator iterator is async-unavailable on macOS), Photos auth now opt-in behind `COLDSTORE_PHOTOS=1` (bare CLI run SIGTRAPs sans Info.plist).
- chore: cross-platform dev loop — OS-correct minio/mc download (`_minio-binaries`), `task ui:demo`/`daemon:run:bg`/`dev:stop`, container `ui/node_modules` named volume, Electron binary self-heal (`ui:_ensure-electron` + `trustedDependencies`).
- docs: Electron UI + daemon verified on macOS (GUI connects, control socket up) across ROADMAP/`coldstorage`+`ui` READMEs/ELECTRON-UI-DESIGN; PhotoKit/FSEvents now compile but stay runtime-untested.
- feat: restore over IPC — `coldstored` `restore file=… out=… [tier days]` command drives the idempotent `RestoreEngine` over the socket with pushed `restore*` events; `task daemon:restore-ipc`. Byte-identical vs MinIO.
- refactor: migrated Core tests XCTest → swift-testing (`@Suite`/`@Test`/`#expect`) — kills the swift-corelibs-XCTest CFRunLoop deadlock on Linux; don't reintroduce `import XCTest`.
- chore: dev-loop self-heal — `daemon:build`/`daemon:test` depend on new `daemon:unlock` (clears stale `.build/.lock`); `gdb` added in `post-create.sh` for wedged-process backtraces (toolchain lldb is broken here).
- docs: `ELECTRON-UI-DESIGN.md` — Electron/React UI brief; UI is a thin client speaking the daemon's JSONL protocol directly over the socket (no `coldstorectl` spawn).
- feat: graceful error handling — `Failure.swift` `FailureKind` classification (permanent vs transient, SSOT) + per-blob isolation; poison blobs surface as `blobFailed` events, permanent ones skip-listed (`getStatus.permanentlyFailedBlobs`). SDK owns transient retry.
- feat: Electron UI layer 1 — `ui/` Node IPC bridge (typed `DaemonClient` over the control socket, `node:net`); `task ui:setup`/`ui:typecheck`/`ui:prove`. Round-trip + event stream proven vs the live daemon.
- feat: Electron UI layer 2 — electron-vite shell (main/preload/renderer) + secure `contextBridge` IPC (`window.coldstore`) + event-stream→`AppState` fold (`useSyncExternalStore`); `task ui:dev`/`ui:build`/`ui:test`. Reducer+controller tested headless.

## 2026-06-20

- feat: Glacier Deep Archive thaw-aware restore — `S3Store.thawState`/`requestThaw` + idempotent `RestoreEngine.restore`; `coldstore-restore --tier`, exit 75 = still thawing; `task daemon:restore`. Live thaw leg needs real AWS.

- docs: `CLAUDE.md` "START HERE → ROADMAP" orientation + monorepo-structure map; `ROADMAP.md` promotes the control plane to Done and narrows the Mac FSEvents stub.

## 2026-06-19

- chore: devcontainer (Swift toolchain + firewall init), root `.gitignore`, and `Taskfile.yml` task runner.
- chore: agent/skill config — `.claude` + `.agents` skill installs, `skills-lock.json`, `CLAUDE.md` engineering guidelines.
- feat: ColdStorage Swift package — `coldstored` daemon, `coldstore-cli`/`coldstore-restore` CLIs, `ColdStorageCore` (upload/restore engines, S3 store, crypto, journal) + `ColdStorageMac` PhotoKit source.
- feat: phase-0 spikes — `phase0-photos-spike` (Photos library access) and `phase0-upload-spike` (S3 upload).
- docs: `ROADMAP.md`, `UPLOAD-DAEMON-DESIGN.md`, and `daemon-module-split.md` planning docs.
- feat: `coldstored` control plane — unix-socket JSONL IPC (`ControlServer`/`ControlClient`) + pushed `EventBus`, driven by new `coldstorectl`; sources are now a journal-backed registry (SSOT).
- feat: `coldstored` launchd LaunchAgent template + `daemon:install`/`daemon:uninstall`/`daemon:run`/`daemon:ctl` tasks; Mac `FolderWatcher` (FSEvents) wired but un-run off-Mac.
