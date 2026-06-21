# ColdStorage — Roadmap & Orientation

> For us and future agents. One-screen map of *what this is, what's real, what's next.*
> Architecture: [daemon-module-split.md](./daemon-module-split.md) · Engine design: [UPLOAD-DAEMON-DESIGN.md](./UPLOAD-DAEMON-DESIGN.md) · UI plan: [ELECTRON-UI-DESIGN.md](./ELECTRON-UI-DESIGN.md)
> **Private (local-only, gitignored `strategy/`):** product spec, brand voice, marketing copy — business/economics, not in the public repo.

## What it is
A Mac app that works like a **remote SSD for the stuff you can't lose**: drag photos/files in, they're encrypted on-device and archived to S3 Glacier Deep Archive; get them back later with a quoted wait + fee. Convenience layer on S3 for the non-technical "I can't do AWS" user.

## Decisions in force (don't re-litigate)
- **Build to dogfood, skip demand validation** — Ben is target user #1. Build the real V1, defer the commercial layer.
- **Stack:** Electron/React UI (control panel) + a **standalone Swift upload daemon** (launchd). NOT react-native-macos, NOT Tauri/Rust.
- **UI is a thin client over the control socket** — Electron's main process speaks the JSONL protocol directly (Node `net.Socket`), no `coldstorectl` spawn / native bridge. The control protocol IS the UI contract. See [ELECTRON-UI-DESIGN.md](./ELECTRON-UI-DESIGN.md).
- **Upload robustness is the V1 crown jewel** — built bulletproof, not deferred.
- **Correctness before speed** — get it right + proven, *optimize later*. Cross-blob concurrency/throughput is explicitly deferred until there's a real-AWS bench to measure against (local MinIO can't show the win).
- **Brand:** calm, plainspoken, quietly warm, straight. No catastrophe imagery; no privacy over-claims beyond V1; "remote SSD" is a metaphor, never a literal claim.

## Built & PROVEN ✅ (verified end-to-end against MinIO)
The Swift package in [`coldstorage/`](./coldstorage/):
- **Pipeline:** scan → per-file SHA-256 → AES-GCM frame encryption (per-blob DEK, deterministic counter nonces) → batch small files into locality blobs → **resumable S3 multipart** → HeadObject verify → **SQLite/WAL journal** (the SPOF).
- **Restore:** thaw-aware + idempotent — Deep Archive `RestoreObject` thaw (when needed) → ranged GET → decrypt → reassemble → hash-verify (`coldstore-restore`; re-run until it lands). Live thaw leg untested off real AWS (see Stub).
- **Verified by real checks:** unit tests pass · encryption is genuine ciphertext · **resume across a hard kill** (same uploadId reused, zero orphans) · idempotent re-runs · **round-trip byte-identical** for solo *and* batched/offset files.
- **Control plane (verified end-to-end vs MinIO):** registry-driven `coldstored` actor + portable unix-socket JSONL IPC (`ControlServer`/`ControlClient`, socket `0600` = owner-only). Commands `getStatus · listSources · addSource · removeSource · triggerNow · restore · pause · resume · ping`; pushed events `runStarted · fileArchived{file,blob} · runFinished{…,blobsFailed} · blobFailed{blob,kind,message} · sourcesChanged · restoreRequested/restoreInProgress/restoreCompleted · paused/resumed · error`. **Restore over IPC (verified vs MinIO):** `restore file=<id> out=<path> [tier days]` drives the idempotent `RestoreEngine` over the socket — one step per call (request thaw → report progress → download+verify), pushing a progress event for a live watcher; proven byte-identical over the socket (`task daemon:restore-ipc FILE=<id>`). Sources are a **journal-backed registry (SSOT)** — `COLDSTORE_SOURCES` is just a seed; add/remove survive restart (proven: relaunch w/ no env → folders persist, no re-upload). **launchd LaunchAgent** plist template + `task daemon:install`/`daemon:uninstall` (RunAtLoad+KeepAlive). Drive it with `coldstorectl` (`task daemon:run` / `daemon:ctl -- getStatus`; `coldstorectl <sock> watch` for live events).
- **Graceful error handling (verified vs MinIO):** transient retry is the **AWS SDK's** job (built-in backoff — we don't re-implement it). Our layer **classifies** every failure (`FailureKind`: permanent vs transient — SSOT in `Failure.swift`) and **isolates per-blob** — a poison blob is recorded + surfaced as a `blobFailed` event and the run *continues*; permanent failures (the `InvalidStorageClass`/`NoSuchBucket` class) go on an in-memory skip list so the daemon stops re-staging a doomed blob, and show in `getStatus.permanentlyFailedBlobs`. The engine takes `any BlobStore` (DI seam). **Proven:** unit tests (classification + real-pipeline fault-injection via a fake `BlobStore`) + live — daemon survives a real `NoSuchBucket`, pushes `blobFailed{kind:permanent}`, keeps answering, archives nothing falsely. *(In-memory skip only — persisting it needs a journal schema change, deferred.)*
- **Dev loop (no Docker):** native Swift (swiftly) + MinIO binary. `task daemon:setup → daemon:minio → daemon:build → daemon:test → daemon:archive`. Live daemon: `task daemon:run` then `task daemon:ctl -- getStatus`.
- Spikes that de-risked it: [`phase0-upload-spike/`](./phase0-upload-spike/), [`phase0-photos-spike/`](./phase0-photos-spike/) (latter un-run, needs a real Mac).

## Stub / NOT done yet ⛔
- **FSEvents re-scan on a real Mac** — `FolderWatcher` (Mac adapter, `canImport(CoreServices)`) is written + wired to `triggerNow`, but un-compiled/un-run off-Mac (folds into the PhotoKit Mac spike). The daemon falls back to its poll interval until then.
- **Glacier Deep Archive thaw — live-AWS leg only.** The thaw path is now built (`S3Store.thawState`/`requestThaw`; `RestoreEngine.restore` is idempotent — request thaw → report progress → download when ready; `coldstore-restore` re-run UX, exit 75 = still thawing). The decision logic is unit-tested (`ThawStateTests`) and the *ready* leg is round-trip-proven vs MinIO. **Unverifiable here:** the actual Deep Archive `RestoreObject` + hours-long retrieval needs real AWS — exercise on first real-bucket restore.
- **macOS PhotoKit ingest on a real Mac** — TCC-grant-persists-under-launchd is the riskiest open unknown.
- **Cross-blob concurrency / adaptive throughput** — sequential today (the `any BlobStore` seam + per-blob isolation now set this up). *Persistent* poison-blob state (survive restart) also pending — needs a journal schema change.
- **Electron/React UI** — **layers 1 + 2 DONE ✅** ([`ui/`](./ui/)). Layer 1: typed `DaemonClient` over the control socket (`task ui:prove`, round-trip + event-stream proven vs the live daemon). Layer 2: electron-vite shell (main/preload/renderer) + secure IPC (`contextIsolation` + `contextBridge` → `window.coldstore`) + event-stream→`AppState` fold (store + `useSyncExternalStore`); proven by `task ui:typecheck` + `task ui:build` (all 3 processes compile) + `task ui:test` (real reducer + controller, headless). **Layer 3 (React views + design system) is next** — `App.tsx` exists functional-but-unstyled. Plan + decisions in [ELECTRON-UI-DESIGN.md](./ELECTRON-UI-DESIGN.md). GUI window + live IPC round-trip smoke-tested on macOS (`task ui:dev` vs the live daemon). **R2 thumbnails + browse index** is the one UI view blocked on infra (needs the R2 bucket).
- **Infra** — `infra/coldstorage` Terraform (S3 GDA + R2 + abort-incomplete-multipart lifecycle + OIDC). Taskfile `tf:coldstorage:*` wired; dirs not scaffolded.
- **Commercial layer (deferred by decision):** web subscription/payment/MoR, dunning, ZK, legacy/death.

## Next (priority order)
1. **macOS PhotoKit + FSEvents spike** on a real Mac — TCC-under-launchd grant + compile/run the `FolderWatcher`.
2. **`infra/coldstorage` Terraform.**
3. **Graceful error handling — DONE ✅** (classification SSOT + per-blob isolation + skip-list, live-proven; SDK owns transient retry). Remaining in this lane: **cross-blob concurrency** (the `BlobStore` seam enables it) + *persistent* poison state (journal schema change).
4. **Restore over IPC — DONE ✅** (`restore` command + `restore*` events, byte-identical proof vs MinIO). Remaining in this lane → **Electron UI** (plan in [ELECTRON-UI-DESIGN.md](./ELECTRON-UI-DESIGN.md)): layer 1 (Node `net.Socket` IPC bridge) **DONE ✅** ([`ui/`](./ui/), `task ui:prove`) → layer 2 (electron-vite shell + main↔renderer IPC + event-stream→typed state) **DONE ✅** (`task ui:build` + `task ui:test`) → **next: layer 3** (React views; design system handed over *here* — `App.tsx` is unstyled scaffolding). Status/sources/restore views work against the daemon today; the **R2 browse index/thumbnails view is blocked on infra** (item 2 — the R2 bucket isn't scaffolded), so it slots in after.

## Verify locally
```sh
task daemon:setup && task daemon:minio && task daemon:build && task daemon:test
task daemon:archive            # encrypt → resumable multipart → verify
# resume + round-trip proofs: /tmp/verify.sh and /tmp/roundtrip.sh patterns

# UI layer-1 IPC bridge (needs a live daemon):
task ui:setup                  # bun install (once)
task daemon:run &              # start the daemon (wait for coldstorage/coldstored.sock)
task ui:prove                  # getStatus round-trips + triggerNow streams runStarted→…→runFinished
task ui:typecheck              # strict tsc over ui/
```

## Dev environment & gotchas (read before building — saves hours)
- **No Docker here.** Toolchain is **native**: Swift via `swiftly` (installed to `~/.local/share/swiftly`), MinIO + `mc` as plain binaries. `task daemon:setup` installs both idempotently; `.devcontainer/post-create.sh` does it on rebuild.
- **`swift` on PATH:** new shells source `~/.local/share/swiftly/env.sh` (wired into `~/.zshrc`/`~/.bashrc`). If `swift: command not found`, `source` that file or open a new terminal.
- **SwiftPM build lock — THE footgun:** if a `swift build`/`swift test` is killed mid-flight, a leftover process can hold `.build/.lock` (a dotfile) and **every later build blocks at 0% CPU, looking "hung."** Now self-healing: `task daemon:build`/`daemon:test` depend on `daemon:unlock` (clears a stale lock when no build/test is live). Manual fix: `task daemon:unlock` (or `pkill -9 -f swift-build; pkill -9 -x swift-test; rm -f .build/.lock`). **Don't wrap `swift test`/`swift build` in `timeout`** — the swiftly `swift` shim detaches `swift-test`, so `timeout` reaps the shim while the real worker (and its `xctest` child) runs on unbounded. Reap by name instead (`pkill … swift-test`/`ColdStoragePackageTests`).
- **Flaky test hang — FIXED 2026-06-20 (was swift-corelibs-XCTest, not our code).** Symptom: I/O-touching tests hung at 0% CPU (~15% idle, ~100% under load). gdb backtrace pinned it to the main thread stuck in `XCTest.awaitUsingExpectation → CFRunLoopRun → ppoll` — a known unresolved XCTest-on-Linux deadlock ([swift-corelibs-xctest#504](https://github.com/swiftlang/swift-corelibs-xctest/issues/504)): the CFRunLoop driving each test's completion occasionally loses its libdispatch wakeup. **Fix: migrated the whole suite to swift-testing** (`@Suite`/`@Test`/`#expect`/`#require`) — Swift-Concurrency-based, no CFRunLoop. Stress-verified 20/20 clean (0.02s/run). `task daemon:test` is back to a plain `swift test`. Don't reintroduce XCTest (`import XCTest`/`XCTestCase`) — it brings the deadlock back.
- **Debugging wedged Swift procs:** use **gdb** (installed + in post-create): `sudo gdb -p <pid> -batch -ex 'thread apply all bt'`. The toolchain's lldb is broken here (wants libpython3.12; box has 3.14).
- **Builds are ~60s** (debug-linking the full AWS SDK); *incrementals are seconds* once warm. Don't spawn parallel builds — they contend.
- **Inspect the journal:** `sqlite3 coldstorage/coldstore.sqlite` (install `sqlite3` CLI via apt; the daemon itself uses libsqlite3 directly).
- **MinIO console:** http://localhost:9001 (`minioadmin`/`minioadmin`). Storage class is conditional — `DEEP_ARCHIVE` on real AWS, omitted for MinIO (which rejects it).
