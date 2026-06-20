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
- **Restore:** ranged GET → decrypt → reassemble → hash-verify (`coldstore-restore`).
- **Verified by real checks:** unit tests pass · encryption is genuine ciphertext · **resume across a hard kill** (same uploadId reused, zero orphans) · idempotent re-runs · **round-trip byte-identical** for solo *and* batched/offset files.
- **Control plane:** registry-driven `coldstored` actor + a portable unix-socket IPC (`ControlServer`/`ControlClient`) with a pushed event stream; journal is the SSOT for sources. Drive it with `coldstorectl`.
- **Dev loop (no Docker):** native Swift (swiftly) + MinIO binary. `task daemon:setup → daemon:minio → daemon:build → daemon:test → daemon:archive`. Live daemon: `task daemon:run` then `task daemon:ctl -- getStatus`.
- Spikes that de-risked it: [`phase0-upload-spike/`](./phase0-upload-spike/), [`phase0-photos-spike/`](./phase0-photos-spike/) (latter un-run, needs a real Mac).

## Stub / NOT done yet ⛔
- **`coldstored` daemon — control plane DONE ✅ (verified end-to-end against MinIO):** the loop+status v0 now has a **unix-socket JSONL IPC** (portable Core): commands `ping · getStatus · listSources · addSource · removeSource · triggerNow · pause · resume` + a **server-push event stream** (`runStarted · fileArchived{file,blob} · runFinished · sourcesChanged · paused/resumed · error`). **Sources are a journal-backed registry (SSOT)** — `COLDSTORE_SOURCES` is now just a one-time seed; add/remove flow through IPC and **survive restart** (proven: relaunch w/ no env → both folders persist, no re-upload). Socket is `0600` (owner-only local auth). Driven by **`coldstorectl`** (`task daemon:run` / `daemon:ctl`); live per-file `fileArchived` events proven via `coldstorectl watch`. **launchd LaunchAgent** plist template + `task daemon:install`/`daemon:uninstall` (RunAtLoad+KeepAlive, Background/LowPriorityIO). **Remaining (needs a real Mac):** the **FSEvents `FolderWatcher`** is written (Mac adapter, `canImport(CoreServices)`) + wired to `triggerNow`, but un-compiled/un-run off-Mac.
- **Glacier Deep Archive thaw** (`RestoreObject`) before the restore GET — round-trip proven against STANDARD/MinIO only; decrypt logic is proven, the thaw call isn't wired (TODO in `S3Store.getRange`).
- **macOS PhotoKit ingest on a real Mac** — TCC-grant-persists-under-launchd is the riskiest open unknown.
- **Graceful S3 error handling** — errors currently crash (e.g. the InvalidStorageClass fatal we hit).
- **Cross-blob concurrency / adaptive throughput** — sequential today.
- **R2 thumbnails + browse index**; **Electron/React UI**.
- **Infra** — `infra/coldstorage` Terraform (S3 GDA + R2 + abort-incomplete-multipart lifecycle + OIDC). Taskfile `tf:coldstorage:*` wired; dirs not scaffolded.
- **Commercial layer (deferred by decision):** web subscription/payment/MoR, dunning, ZK, legacy/death.

## Next (priority order)
1. **Glacier thaw path** for real-AWS restore (`RestoreObject` before the GET; decrypt already proven).
2. **macOS PhotoKit + FSEvents spike** on a real Mac — TCC-under-launchd grant + compile/run the `FolderWatcher`.
3. **`infra/coldstorage` Terraform.**
4. Graceful error handling (the loop now *surfaces* errors as `error` events instead of crashing, but per-error classification/retry is still TODO) + cross-blob concurrency.
5. R2 browse index → Electron UI (the UI is a thin client over the now-built control socket — see `ControlClient`).

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
