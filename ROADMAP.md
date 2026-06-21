# ColdStorage — Roadmap & Orientation

> For us and future agents. One-screen map of *what this is, what's real, what's next.*
> Architecture: [daemon-module-split.md](./daemon-module-split.md) · Engine design: [UPLOAD-DAEMON-DESIGN.md](./UPLOAD-DAEMON-DESIGN.md)
> **Private (local-only, gitignored `strategy/`):** product spec, brand voice, marketing copy — business/economics, not in the public repo.

## What it is
A Mac app that works like a **remote SSD for the stuff you can't lose**: drag photos/files in, they're encrypted on-device and archived to S3 Glacier Deep Archive; get them back later with a quoted wait + fee. Convenience layer on S3 for the non-technical "I can't do AWS" user.

## Decisions in force (don't re-litigate)
- **Build to dogfood, skip demand validation** — Ben is target user #1. Build the real V1, defer the commercial layer.
- **Stack:** Electron/React UI (control panel) + a **standalone Swift upload daemon** (launchd). NOT react-native-macos, NOT Tauri/Rust.
- **Upload robustness is the V1 crown jewel** — built bulletproof, not deferred.
- **Brand:** calm, plainspoken, quietly warm, straight. No catastrophe imagery; no privacy over-claims beyond V1; "remote SSD" is a metaphor, never a literal claim.

## Built & PROVEN ✅ (verified end-to-end against MinIO)
The Swift package in [`coldstorage/`](./coldstorage/):
- **Pipeline:** scan → per-file SHA-256 → AES-GCM frame encryption (per-blob DEK, deterministic counter nonces) → batch small files into locality blobs → **resumable S3 multipart** → HeadObject verify → **SQLite/WAL journal** (the SPOF).
- **Restore:** thaw-aware + idempotent — Deep Archive `RestoreObject` thaw (when needed) → ranged GET → decrypt → reassemble → hash-verify (`coldstore-restore`; re-run until it lands). Live thaw leg untested off real AWS (see Stub).
- **Verified by real checks:** unit tests pass · encryption is genuine ciphertext · **resume across a hard kill** (same uploadId reused, zero orphans) · idempotent re-runs · **round-trip byte-identical** for solo *and* batched/offset files.
- **Control plane (verified end-to-end vs MinIO):** registry-driven `coldstored` actor + portable unix-socket JSONL IPC (`ControlServer`/`ControlClient`, socket `0600` = owner-only). Commands `getStatus · listSources · addSource · removeSource · triggerNow · restore · pause · resume · ping`; pushed events `runStarted · fileArchived{file,blob} · runFinished · sourcesChanged · restoreRequested/restoreInProgress/restoreCompleted · paused/resumed · error`. **Restore over IPC (verified vs MinIO):** `restore file=<id> out=<path> [tier days]` drives the idempotent `RestoreEngine` over the socket — one step per call (request thaw → report progress → download+verify), pushing a progress event for a live watcher; proven byte-identical over the socket (`task daemon:restore-ipc FILE=<id>`). Sources are a **journal-backed registry (SSOT)** — `COLDSTORE_SOURCES` is just a seed; add/remove survive restart (proven: relaunch w/ no env → folders persist, no re-upload). **launchd LaunchAgent** plist template + `task daemon:install`/`daemon:uninstall` (RunAtLoad+KeepAlive). Drive it with `coldstorectl` (`task daemon:run` / `daemon:ctl -- getStatus`; `coldstorectl <sock> watch` for live events).
- **Dev loop (no Docker):** native Swift (swiftly) + MinIO binary. `task daemon:setup → daemon:minio → daemon:build → daemon:test → daemon:archive`. Live daemon: `task daemon:run` then `task daemon:ctl -- getStatus`.
- Spikes that de-risked it: [`phase0-upload-spike/`](./phase0-upload-spike/), [`phase0-photos-spike/`](./phase0-photos-spike/) (latter un-run, needs a real Mac).

## Stub / NOT done yet ⛔
- **FSEvents re-scan on a real Mac** — `FolderWatcher` (Mac adapter, `canImport(CoreServices)`) is written + wired to `triggerNow`, but un-compiled/un-run off-Mac (folds into the PhotoKit Mac spike). The daemon falls back to its poll interval until then.
- **Glacier Deep Archive thaw — live-AWS leg only.** The thaw path is now built (`S3Store.thawState`/`requestThaw`; `RestoreEngine.restore` is idempotent — request thaw → report progress → download when ready; `coldstore-restore` re-run UX, exit 75 = still thawing). The decision logic is unit-tested (`ThawStateTests`) and the *ready* leg is round-trip-proven vs MinIO. **Unverifiable here:** the actual Deep Archive `RestoreObject` + hours-long retrieval needs real AWS — exercise on first real-bucket restore.
- **macOS PhotoKit ingest on a real Mac** — TCC-grant-persists-under-launchd is the riskiest open unknown.
- **Graceful S3 error handling** — errors currently crash (e.g. the InvalidStorageClass fatal we hit).
- **Cross-blob concurrency / adaptive throughput** — sequential today.
- **R2 thumbnails + browse index**; **Electron/React UI**.
- **Infra** — `infra/coldstorage` Terraform (S3 GDA + R2 + abort-incomplete-multipart lifecycle + OIDC). Taskfile `tf:coldstorage:*` wired; dirs not scaffolded.
- **Commercial layer (deferred by decision):** web subscription/payment/MoR, dunning, ZK, legacy/death.

## Next (priority order)
1. **macOS PhotoKit + FSEvents spike** on a real Mac — TCC-under-launchd grant + compile/run the `FolderWatcher`.
2. **`infra/coldstorage` Terraform.**
3. Graceful error handling (the loop now *surfaces* errors as `error` events instead of crashing, but per-error classification/retry is still TODO) + cross-blob concurrency.
4. **Restore over IPC — DONE ✅** (`restore` command + `restore*` events, byte-identical proof vs MinIO). Remaining in this lane: R2 browse index → Electron UI (thin client over the control socket — see `ControlClient`).

## Verify locally
```sh
task daemon:setup && task daemon:minio && task daemon:build && task daemon:test
task daemon:archive            # encrypt → resumable multipart → verify
# resume + round-trip proofs: /tmp/verify.sh and /tmp/roundtrip.sh patterns
```

## Dev environment & gotchas (read before building — saves hours)
- **No Docker here.** Toolchain is **native**: Swift via `swiftly` (installed to `~/.local/share/swiftly`), MinIO + `mc` as plain binaries. `task daemon:setup` installs both idempotently; `.devcontainer/post-create.sh` does it on rebuild.
- **`swift` on PATH:** new shells source `~/.local/share/swiftly/env.sh` (wired into `~/.zshrc`/`~/.bashrc`). If `swift: command not found`, `source` that file or open a new terminal.
- **SwiftPM build lock — THE footgun:** if a `swift build`/`swift test` is killed mid-flight, a leftover process can hold `.build/.lock` (a dotfile) and **every later build blocks at 0% CPU, looking "hung."** Fix: `pkill -9 -f swift-build; pkill -9 -x swift-test; rm -f .build/.lock`. Check a "slow" build's CPU% before assuming it's just slow.
- **Builds are ~60s** (debug-linking the full AWS SDK); *incrementals are seconds* once warm. Don't spawn parallel builds — they contend.
- **Inspect the journal:** `sqlite3 coldstorage/coldstore.sqlite` (install `sqlite3` CLI via apt; the daemon itself uses libsqlite3 directly).
- **MinIO console:** http://localhost:9001 (`minioadmin`/`minioadmin`). Storage class is conditional — `DEEP_ARCHIVE` on real AWS, omitted for MinIO (which rejects it).
