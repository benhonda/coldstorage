# Changelog

## 2026-06-26

- feat: daemon photos are EXPLICIT-deposit only (product decision) — removed the spike-grade `COLDSTORE_PHOTOS=1` enumerate-whole-library auto-watch path (`platformSources` now empty); `PhotoKitSource` stays (its proven `stream(assetId:)` feeds the to-build `depositPhotos` path) but is flagged DO-NOT-wire-as-background; `coldstored` now imports `ColdStorageMac` under `canImport(CoreServices)` for `FolderWatcher`. `daemon:install` carries a NOTE that the future photo path must embed `coldstored-Info.plist` + codesign. Docs synced (ROADMAP/`coldstorage` README).
- feat: `phase0-photos-spike` PROVEN on a real Mac — durable Photos TCC grant survives a launchd relaunch (signed binary + Info.plist embedded via `-sectcreate`, no `.app` bundle) and reads the true full-res `.photo` original incl. on-demand iCloud download; Swift-6 fix — stream from a top-level nonisolated fn (MainActor closures trip the executor assertion on Photos' `fileIO` queue → SIGTRAP). Spike `Taskfile` auto-detects the Apple Development identity, auto-fills the launchd binary path, adds a `crashlog` SIGTRAP diagnoser; spike originals (`original-*`) gitignored.
- feat: Settings watched-folder row redesign — each row is a rounded accent folder tile + source → destination (`~`-shortened Mac path over `↳ My Files / <mount>`), an at-a-glance status badge (Up to date · Syncing… · Not watching), and a ghost `⋯` menu with Stop / Start watching (the reversible per-source pause) and Remove… (confirm dialog — uploaded files stay in My Files). "Catch up now" → "Sync now". New `cs-iconbtn--ghost` primitive; `cs-menu-item` no longer wraps.
- fix: watched-folder status badge + "Sync now" button now read the live run state (`run.active`), not `status.running` — which only updates on a getStatus poll and so never reflected an in-flight scan (the badge was stuck on "Up to date").
- feat: Settings watched folders — `AddWatchedFolderModal` (native folder picker + a `FolderTree` drive-destination picker, shared with the move dialog) issues `addSource` with `mountPath`; per-folder pause/resume via `pauseSource`/`resumeSource`. Global pause/resume removed (`Status.paused` + `paused`/`resumed` events gone).
- feat: My Files new-folder anchors via `createFolder` — the new-folder gesture issues the real daemon marker (optimistic empty-folder row + inline rename) instead of a local-only virtual path.
- feat: daemon per-source pause + mount destinations — `SourceRow` gains journal-persisted `paused` + `mountPath` (replaces the transient global pause flag); `pauseSource`/`resumeSource` replace `pause`/`resume`; `addSource path= mountPath=`; `MountedSource` re-bases items so a watched folder lands at its chosen drive path and same-named files don't collide on `id`. Proven vs MinIO.
- feat: daemon `createFolder` — `FileStatus.folder` path-only marker anchors an empty folder so it survives a reload (no S3/no thaw); emits `filesChanged{created}`.

## 2026-06-25

- feat: Settings exclude chips on real daemon excludes — fetch/add/remove via `listExcludes`/`addExclude`/`removeExclude` (replaces the hardcoded `useSettings.ts`), refetch on `excludesChanged`.
- feat: cost estimates from one source — `pricing.ts` (bytes×rate, fed by `getPricing` → `state.pricing`, `FALLBACK_PRICING` seeds first paint) drives Settings storage/mo + the request-a-copy retrieval fee.
- feat: daemon scan excludes — `ExcludeMatcher` (gitignore-flavored: bare names match at any depth, `*`/`?` globs) applied inside the `LocalDirSource` walk + deposit so junk is never hashed and excluded folders never descended; journal-persisted `excludes` + `listExcludes`/`addExclude`/`removeExclude` commands + `excludesChanged` event; `task daemon:exclude-ipc`. Proven vs MinIO.
- feat: daemon `getPricing` rate card — `Pricing`/`RestoreTier` SSOT (Deep Archive storage $/GB-mo + per-tier retrieval $/GB + estimate disclaimer) over the socket, so cost copy isn't scattered magic numbers.
- feat: rename via press-and-hold (500ms, 8px drift-cancel) in `MyFilesView`, not double-click — double-click now *opens* the row (folder drills in / file Get-info); `cs-fl-label` gets `user-select:none` so the hold doesn't paint a selection.
- docs: sync design docs to the shipped move/rename/delete contract — `movePath`/`deletePath`/`filesChanged` added to the command + event SSOT and flipped DONE across `ELECTRON-UI-DESIGN`/`UPLOAD-DAEMON-DESIGN`/`coldstorage`+`ui` READMEs; `newFolder` noted as the lone remaining local-only seam.
- feat: UI move/rename/delete on real daemon commands — reorganize/delete fire `movePath`/`deletePath` (optimistic local edit, reconciled by the `filesChanged`→`listFiles` refetch); `targetOf` keys the full vault-relative path. UI 44 tests.
- feat: daemon move/rename/delete — `movePath` (journal `relativePath` prefix-sweep; one primitive for file/folder move AND rename; id-stable so no re-upload) + `deletePath` (tombstone `status=deleted`, row+blob kept for deferred GC, dropped from `listFiles`); `filesChanged` event; `task daemon:move-ipc`/`daemon:delete-ipc`. Proven vs MinIO.
- docs: sync design docs to the shipped `uploadProgress`/per-file-`failed` contract (event SSOT + READMEs + ROADMAP/ELECTRON-UI-DESIGN) + stale-fact fixes — journal is `libsqlite3` not GRDB, CLAUDE.md infra now applied, `daemon-module-split` executables list.
- feat: UI determinate upload bar + journal-truth failed rows — reducer folds `uploadProgress` (per-file %, keyed by id, cleared as each file archives) into a determinate bar; `blobFailed` paths flip the affected rows to ⚠ and name them in `FailuresPanel`. UI 42 tests.
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
