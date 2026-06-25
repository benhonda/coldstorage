# Changelog

## 2026-06-25

- feat: daemon `uploadProgress` event + per-file `failed` status — `UploadEngine` emits determinate progress (bytes/encrypted-total, per 64 MiB part, solo-blob large files); a permanent blob failure persists its files as `failed` (`Journal.markFilesFailed`, survives restart) and `blobFailed` now carries the affected paths. Proven vs MinIO.

## 2026-06-24

- feat: My Files browser runs on real daemon data — swap `fixtures.ts` for live `listFiles` (journal tree → store `state.files` → `model.fileFromJournal`), drop-to-upload issues the real `deposit` command, request-a-copy resolves end-to-end; `pathForFile` preload (`webUtils.getPathForFile`, Electron 32+). Proven vs MinIO (`task ui:prove`).
- feat: UI upload error states — `FailuresPanel` + sidebar "N couldn't upload", ⚠ row marker (kept visible), Retry-upload row action (re-issues `deposit`), light-red toast, indeterminate upload bar; `ui:test` 34 pass.
- feat: daemon `listFiles` + `deposit` commands — `Journal.listFiles` (pure metadata SELECT, the browsable-tree SSOT; no S3/no thaw) + ad-hoc drop-to-upload `deposit` (`ExplicitPathsSource` archives dropped paths once with no watched source, fire-and-forget); `task daemon:deposit-ipc`. Proven vs MinIO.
- feat: UI reorganizable-filesystem redesign — `MyFilesView` browser (drop-to-upload, status icons, row ⋯ menu + Get-info modal, reorganize, request-a-copy) + `SettingsView` replace the 4-tab Vault/Sources/Restore/Browse layout; pure headless-tested `views/files/model.ts` tree (fixtures stand in for `listFiles`); new `Chip`/`Modal` primitives + resizable sidebar; `ui:test` now covers the renderer (28 pass).
- feat: native folder picker + Downloads dir over IPC (`main/system.ts`, `chooseFolder`/`getDownloadsDir`) for the request-a-copy save dialog.
- docs: `ELECTRON-UI-DESIGN.md` canonical UI redesign — reorganizable-filesystem (My Files browser + Settings) supersedes the 4-tab layout; adds the daemon contract-gap build spec (`listFiles` unblocks browse).
- docs: corrected browse as journal-backed (paths/sizes/status from the `files` table, no thaw) — only thumbnails need R2, not the whole view; synced across `ROADMAP.md` + `ui/README.md`.

## 2026-06-23

- feat: Electron UI layer 3 — React views (Vault/Sources/Restore) skinned in the coldstorage Design System, ported to native React 19 TSX bound to vendored token vars (`ui/src/renderer/src/{styles,ui,views}/`); `App.tsx` now a thin sidebar-routing shell + error toast; self-hosted fonts (Fontsource + `material-symbols`) so they bundle same-origin under the locked-down CSP; `task ui:live` dogfoods the UI against the installed launchd daemon. `task ui:typecheck` + `task ui:build` green; macOS visual-verify pending.
- feat: daemon LIVE on macOS — `task daemon:bootstrap` + `task daemon:doctor` green; AWS auth resolves end-to-end (`profile → credential_process → Keychain`) as the scoped prod IAM user, LaunchAgent running, `getStatus` answers; new `task daemon:live -- <cmd>` drives the installed daemon against real Deep Archive (first real upload path now open).

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
