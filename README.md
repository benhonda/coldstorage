# ColdStorage

A Mac app that works like a **remote SSD for the stuff you can't lose**: drag photos/files in, they're
encrypted on your Mac and uploaded to S3 Glacier Deep Archive; request a copy back later with a quoted
wait + fee. A convenience layer on S3 for the "I can't do AWS" user. ("Remote SSD" is a metaphor,
never a literal claim.)

Currently **dogfooding V1**; the multi-user/paid layer is in build — see [`PROD.md`](./PROD.md).

## Layout & docs

| Where | What |
|---|---|
| [`coldstorage/`](./coldstorage/) | The Swift package: portable `ColdStorageCore` (engine, journal, crypto, control plane) + `ColdStorageMac` adapter (PhotoKit, FSEvents) + executables (`coldstored`, `coldstorectl`, `coldstore-cli`, `coldstore-restore`, `coldstore-photo-picker`). Docs: [`README.md`](./coldstorage/README.md) (run it) · [`DESIGN.md`](./coldstorage/DESIGN.md) (how/why it's built). |
| [`ui/`](./ui/) | Electron/React control panel — a thin client over the daemon's control socket. Docs: [`README.md`](./ui/README.md) · [`DESIGN.md`](./ui/DESIGN.md) (UX + contract) · [`PACKAGING.md`](./ui/PACKAGING.md) (the `.app`). |
| [`account-backend/`](./account-backend/) | Hono API on Vercel + Neon/Drizzle: Cognito ↔ Paddle ↔ zero-knowledge key-blob backend for the paid layer ([`PROD.md`](./PROD.md) Phase 4). |
| [`site/`](./site/) | Marketing site + checkout page — RR7/adpharm-stack on Vercel, **live at [coldstorage.sh](https://coldstorage.sh)**. Sections designed upstream in Claude cloud design, synced to `site/design-mirror/`. Docs: [`SPEC.md`](./site/SPEC.md) (build + design-sync architecture). |
| [`infra/coldstorage/`](./infra/coldstorage/) | Terraform/Terragrunt: S3 Deep Archive vault + lifecycle + least-priv daemon IAM + Cognito. |
| [`infra/account-backend/`](./infra/account-backend/) | Terraform/Terragrunt for the backend's Vercel project (production + staging). |
| [`infra/site/`](./infra/site/) | Terraform/Terragrunt for the marketing site's Vercel project (production + staging; DNS is Vercel-managed). |
| `phase0-*-spike/` | De-risking spikes (both run + proven; seeds of the core). |
| [`PROD.md`](./PROD.md) | The going-to-prod plan (identity, per-user isolation, ZK keys, billing, distribution) — the active work's SSOT. |
| [`CHANGELOG.md`](./CHANGELOG.md) | The build history. |

Everything runs through the root [`Taskfile.yml`](./Taskfile.yml) (`task --list`): `daemon:*`, `ui:*`,
`backend:*`, the site's `dev:site`/`typecheck:site`, `tf:*`, plus interactive pickers (`start`/`dev`, `tf:plan`, `link`, `pull`).

## Architecture decisions (don't re-litigate)
- **Stack:** Electron/React control panel + a **standalone Swift upload daemon** (launchd LaunchAgent).
  NOT react-native-macos, NOT Tauri/Rust.
- **The UI is a thin client over the control socket** — Electron main speaks the JSONL protocol
  directly; the control protocol IS the UI contract ([`ui/DESIGN.md`](./ui/DESIGN.md)).
- **Upload robustness is the crown jewel** — built bulletproof, not deferred.
- **Correctness before speed** — cross-blob concurrency/throughput is deferred until there's a
  real-AWS bench to measure against.
- **Photos (and everything else) are explicit-deposit** — the user picks what to upload; breadth of an
  OS permission grant is never a license to slurp a library/drive.
- Going-to-prod decisions (direct download not MAS, Paddle MoR, zero-knowledge keys, Cognito) are
  detailed in [`PROD.md`](./PROD.md).

## Verify locally (no Docker, no Mac)
```sh
task daemon:setup && task daemon:minio && task daemon:build:dev
task daemon:test               # portable Core tests (swift-testing)
task daemon:archive            # scan → encrypt → resumable multipart → verify; Ctrl-C + re-run resumes

task ui:setup                  # bun install (once)
task daemon:run &              # wait for coldstorage/coldstored.sock
task ui:prove                  # socket round-trip + live event stream
task ui:test && task ui:typecheck
```
On a Mac: `task daemon:mac:bootstrap` (creds → Keychain + launchd install), `task daemon:mac:doctor`,
`task ui:mac:live` to dogfood the UI against the installed daemon, `task ui:mac:package` for the `.app`.

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
- **The daemon states its identity or refuses to start (2026-07-13).** `coldstored` needs *exactly one* of
  Cognito config (multi-user) or `COLDSTORE_DEV_IDENTITY=<name>` (local dev) — with neither it prints why
  and exits 2, rather than silently signing S3 calls as the shared all-access IAM user. `task daemon:run`
  already sets it; `task daemon:mac:install` now fails fast if the Cognito handoff is missing. If you have
  a Mac data dir from before this, run **`task daemon:mac:reset:local` once** — the old machine-wide
  `coldstore.sqlite` is orphaned (and is the file that leaked one account's index to the next).
- **Inspect the journal:** it's **per signed-in user**, under the daemon's data root —
  `sqlite3 coldstorage/.dev-data/users/dev-local/coldstore.sqlite` for the dev daemon (`task
  daemon:run`), `~/Library/Application Support/ColdStorage/users/<cognito-sub>/coldstore.sqlite` for
  the installed one. There is no machine-wide journal. **MinIO console:**
  http://localhost:9001 (`minioadmin`/`minioadmin`). Storage class is conditional — `DEEP_ARCHIVE` on
  real AWS, omitted for MinIO.
- **VS Code port-forward hijack:** VS Code can resurrect a stale 9000/9001 forward that blocks native
  MinIO (`mc alias set` hangs). `.vscode/settings.json` sets `"remote.restoreForwardedPorts": false`,
  but `.vscode/` is gitignored — a fresh devcontainer needs it re-applied. Symptom check:
  `lsof -nP -iTCP:9000 -sTCP:LISTEN` showing `Code Helper`.
- **libsodium is built from source on Linux** (`task daemon:setup`) — Ubuntu's apt 1.0.18 predates
  symbols swift-sodium needs; Apple platforms use the bundled XCFramework.
