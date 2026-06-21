# Changelog

## 2026-06-21

- feat: restore over IPC — `coldstored` `restore file=… out=… [tier days]` command drives the idempotent `RestoreEngine` over the socket with pushed `restore*` events; `task daemon:restore-ipc`. Byte-identical vs MinIO.
- refactor: migrated Core tests XCTest → swift-testing (`@Suite`/`@Test`/`#expect`) — kills the swift-corelibs-XCTest CFRunLoop deadlock on Linux; don't reintroduce `import XCTest`.
- chore: dev-loop self-heal — `daemon:build`/`daemon:test` depend on new `daemon:unlock` (clears stale `.build/.lock`); `gdb` added in `post-create.sh` for wedged-process backtraces (toolchain lldb is broken here).
- docs: `ELECTRON-UI-DESIGN.md` — Electron/React UI brief; UI is a thin client speaking the daemon's JSONL protocol directly over the socket (no `coldstorectl` spawn).
- feat: graceful error handling — `Failure.swift` `FailureKind` classification (permanent vs transient, SSOT) + per-blob isolation; poison blobs surface as `blobFailed` events, permanent ones skip-listed (`getStatus.permanentlyFailedBlobs`). SDK owns transient retry.

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
