# ColdStorage

A Mac app that works like a **remote SSD for the stuff you can't lose**: drag photos/files in, they're
encrypted on your Mac and uploaded to S3 Glacier Deep Archive; request a copy back later with a quoted
wait + fee. A convenience layer on S3 for the "I can't do AWS" user. ("Remote SSD" is a metaphor,
never a literal claim.)

Currently **dogfooding V1** (Ben is user #1); the multi-user/paid layer is in build — see
[`PROD.md`](./PROD.md).

## Layout & docs

| Where | What |
|---|---|
| [`coldstorage/`](./coldstorage/) | The Swift package: portable `ColdStorageCore` (engine, journal, crypto, control plane) + `ColdStorageMac` adapter (PhotoKit, FSEvents) + executables (`coldstored`, `coldstorectl`, `coldstore-cli`, `coldstore-restore`, `coldstore-photo-picker`). Docs: [`README.md`](./coldstorage/README.md) (run it) · [`DESIGN.md`](./coldstorage/DESIGN.md) (how/why it's built). |
| [`ui/`](./ui/) | Electron/React control panel — a thin client over the daemon's control socket. Docs: [`README.md`](./ui/README.md) · [`DESIGN.md`](./ui/DESIGN.md) (UX + contract) · [`PACKAGING.md`](./ui/PACKAGING.md) (the `.app`). |
| [`account-backend/`](./account-backend/) | Hono API on Vercel + Neon/Drizzle: Cognito ↔ Paddle ↔ zero-knowledge key-blob backend for the paid layer. Staging lane stood up 2026-07-02; production lane pending ([`PROD.md`](./PROD.md) Phase 4). |
| [`infra/coldstorage/`](./infra/coldstorage/) | Terraform/Terragrunt: S3 Deep Archive vault + lifecycle + least-priv daemon IAM + Cognito. **Applied — prod is live.** |
| [`infra/account-backend/`](./infra/account-backend/) | Terraform/Terragrunt for the backend's Vercel project (production + staging). **Applied.** |
| `phase0-*-spike/` | De-risking spikes (both run + proven; seeds of the core). |
| [`PROD.md`](./PROD.md) | The going-to-prod plan (identity, per-user isolation, ZK keys, billing, distribution) — the active work's SSOT. |
| [`CHANGELOG.md`](./CHANGELOG.md) | The full build history + forensics. |
| `strategy/` | **Gitignored, private:** product spec, brand voice, economics. Not in the public repo. |

Everything runs through the root [`Taskfile.yml`](./Taskfile.yml) (`task --list`): `daemon:*`, `ui:*`,
`backend:*`, `tf:*`, plus interactive pickers (`tf:plan`, `link`, `pull`).

## Decisions in force (don't re-litigate)
- **Build to dogfood, skip demand validation** — build the real V1, defer the commercial layer.
- **Stack:** Electron/React control panel + a **standalone Swift upload daemon** (launchd LaunchAgent).
  NOT react-native-macos, NOT Tauri/Rust.
- **The UI is a thin client over the control socket** — Electron main speaks the JSONL protocol
  directly; the control protocol IS the UI contract ([`ui/DESIGN.md`](./ui/DESIGN.md)).
- **Upload robustness is the V1 crown jewel** — built bulletproof, not deferred.
- **Correctness before speed** — cross-blob concurrency/throughput is deferred until there's a
  real-AWS bench to measure against.
- **Photos (and everything else) are explicit-deposit** — the user picks what to upload; breadth of an
  OS permission grant is never a license to slurp a library/drive.
- **Brand voice:** calm, plainspoken, factual. No catastrophe imagery, no "safe" claims, no privacy
  over-claims. Status is information, not comfort.
- Going-to-prod decisions (direct download not MAS, Paddle MoR, true zero-knowledge keys, Cognito) are
  locked in [`PROD.md`](./PROD.md).

## State of the world (verified 2026-07-02: 79 Core + 51 UI tests green, typecheck clean)

**Built & proven:**
- **The pipeline** — scan → per-file SHA-256 → AES-GCM frame encryption (per-blob DEK) → locality-
  grouped blobs → resumable S3 multipart → verify → SQLite/WAL journal. Proven vs MinIO including
  resume-across-a-hard-kill (same `uploadId`, zero orphans) and byte-identical round-trips.
- **Against real AWS, end to end** — prod vault applied, daemon live on the Mac (launchd + Keychain
  `credential_process`), real Deep Archive uploads, and the full thaw→ranged-GET→decrypt→verify
  restore completed 2026-06-27. **Zero unproven legs.**
- **The control plane** — JSONL unix-socket commands + event stream (SSOTs in code; lists in
  [`coldstorage/DESIGN.md`](./coldstorage/DESIGN.md) §10). Sources, excludes, pause are journal-backed;
  reorganize (move/rename/delete) is a cheap journal edit, no S3.
- **macOS seams** — durable Photos TCC grant under launchd, explicit photo-deposit via the native
  picker (`PHPickerViewController` helper → `depositPhotos` → full-res iCloud originals), FSEvents
  watcher (re-armable without restart). All proven live on a real Mac.
- **Honest failure handling** — permanent-vs-transient classification (SDK owns transient retry),
  per-blob isolation, per-file `failed` as journal truth, no silent failures.
- **The UI** — My Files (drill-in browser, drop-to-upload, Finder-style collisions, reorganize,
  request-a-copy) + Settings (watched folders w/ mounts + per-source pause, exclude chips, real
  pricing), live progress + error surfacing. Packaged `ColdStorage.app` builds, connects, and uploads.
- **Going-to-prod Phases 1–5** — Cognito live in prod, the daemon's per-user credential/prefix seam
  fully wired (opt-in via env), ZK master-key primitives built + tested, account-backend staging lane
  live at `api-staging.coldstorage.sh` with the Paddle-webhook gate proven, and the whole Phase 5
  auth + paywall steel thread gate-passed on real hardware — Google + email-OTP sign-in, ZK vault +
  recovery code, and the Paddle subscribe→webhook→deposit-gate loop live on staging
  ([`PROD.md`](./PROD.md); Phase 4's production lane stays deferred until Phase 6 needs it).

**Open (priority order):**
1. **[`PROD.md`](./PROD.md) Phase 6 — sign + notarize + ship:** Developer ID signing, notarization,
   auto-update, download page/website. Deferred-by-design stragglers ride along: multi-plan paywall +
   moving the checkout page off `api.*` (pre-launch), daemon-side sign-out, the production backend lane.
2. **Packaging** — TCC identity (Photos pane still says "coldstored"), background-run UX
   ([`ui/PACKAGING.md`](./ui/PACKAGING.md)).
3. **UI-lane gaps** — per-file live status, skipped/failed counts, retry depth, polish
   ([`ui/DESIGN.md`](./ui/DESIGN.md) § Remaining).
4. **Engine deferrals** — cross-blob concurrency (needs a real-AWS bench), persistent poison-blob
   state (journal schema change), content-hash dedup for photo re-deposits, **R2** (photo thumbnails +
   cross-device index — the only R2-gated pieces; browse itself is journal-backed today).

## Verify locally (no Docker, no Mac)
```sh
task daemon:setup && task daemon:minio && task daemon:build:dev
task daemon:test               # 79 portable Core tests (swift-testing)
task daemon:archive            # scan → encrypt → resumable multipart → verify; Ctrl-C + re-run resumes

task ui:setup                  # bun install (once)
task daemon:run &              # wait for coldstorage/coldstored.sock
task ui:prove                  # socket round-trip + live event stream
task ui:test && task ui:typecheck
```
On a Mac: `task daemon:bootstrap` (creds → Keychain + launchd install), `task daemon:doctor`,
`task ui:live` to dogfood the UI against the installed daemon, `task ui:package` for the `.app`.

## Dev environment & gotchas (read before building — saves hours)
- **No Docker.** Native toolchain: Swift via `swiftly`, MinIO + `mc` as plain binaries
  (`task daemon:setup` is idempotent). New shells source `~/.local/share/swiftly/env.sh` — if
  `swift: command not found`, source it or open a new terminal.
- **SwiftPM build lock — THE footgun:** a killed build can leave `.build/.lock` held and every later
  build blocks at 0% CPU looking "hung." `task daemon:build:dev`/`daemon:test` self-heal via
  `daemon:unlock`. **Don't wrap `swift test`/`swift build` in `timeout`** — the swiftly shim detaches
  the real worker; reap by name instead (`pkill -9 -f swift-build; pkill -9 -x swift-test`).
- **Tests are swift-testing, NOT XCTest.** XCTest-on-Linux has an unresolved CFRunLoop deadlock
  ([swift-corelibs-xctest#504](https://github.com/swiftlang/swift-corelibs-xctest/issues/504)) that hung
  this suite until the 2026-06-20 migration. Don't reintroduce `import XCTest`.
- **Debugging wedged Swift procs:** gdb (`sudo gdb -p <pid> -batch -ex 'thread apply all bt'`) — the
  toolchain's lldb is broken here (libpython mismatch).
- **Builds:** cold ~60s (debug-linking the AWS SDK), incrementals seconds. Don't spawn parallel
  builds — and note `swift run` acquires the build lock too, so on a fresh tree run
  `task daemon:build:dev` once before starting daemon + ctl together.
- **Inspect the journal:** `sqlite3 coldstorage/coldstore.sqlite`. **MinIO console:**
  http://localhost:9001 (`minioadmin`/`minioadmin`). Storage class is conditional — `DEEP_ARCHIVE` on
  real AWS, omitted for MinIO.
- **VS Code port-forward hijack:** VS Code can resurrect a stale 9000/9001 forward that blocks native
  MinIO (`mc alias set` hangs). `.vscode/settings.json` sets `"remote.restoreForwardedPorts": false`,
  but `.vscode/` is gitignored — a fresh devcontainer needs it re-applied. Symptom check:
  `lsof -nP -iTCP:9000 -sTCP:LISTEN` showing `Code Helper`.
- **libsodium is built from source on Linux** (`task daemon:setup`) — Ubuntu's apt 1.0.18 predates
  symbols swift-sodium needs; Apple platforms use the bundled XCFramework.
