# ColdStorage

A Mac app that works like a **remote SSD for the stuff you can't lose**: drag photos/files in, they're
encrypted on your Mac and uploaded to S3 Glacier Deep Archive; request a copy back later with a quoted
wait + fee. A convenience layer on S3 for the "I can't do AWS" user. ("Remote SSD" is a metaphor,
never a literal claim.)

Currently **dogfooding V1**; the multi-user/paid layer is in build — see [`PROD.md`](./PROD.md).

## Layout & docs

| Where | What |
|---|---|
| [`coldstorage/`](./coldstorage/) | The Swift package: portable `ColdStorageCore` (engine, journal, crypto, control plane) + `ColdStorageMac` adapter (PhotoKit, FSEvents) + executables (`coldstored`, `coldstorectl`, `coldstore-photo-picker`). Docs: [`README.md`](./coldstorage/README.md) (run it) · [`DESIGN.md`](./coldstorage/DESIGN.md) (how/why it's built). |
| [`ui/`](./ui/) | Electron/React control panel — a thin client over the daemon's control socket. Docs: [`README.md`](./ui/README.md) · [`DESIGN.md`](./ui/DESIGN.md) (UX + contract) · [`PACKAGING.md`](./ui/PACKAGING.md) (the `.app`). |
| [`account-backend/`](./account-backend/) | Hono API on Vercel + Neon/Drizzle: Cognito ↔ Paddle ↔ zero-knowledge key-blob backend for the paid layer ([`PROD.md`](./PROD.md) Phase 4). |
| [`site/`](./site/) | Marketing site + checkout page — RR7/adpharm-stack on Vercel, **live at [coldstorage.sh](https://coldstorage.sh)**. Source of truth for the whole site lives here; Claude cloud design is an import source, not a synced upstream. Docs: [`SPEC.md`](./site/SPEC.md) (build + design-import architecture). |
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
task daemon:setup && task daemon:build:dev
task daemon:test               # the Core suite: scan → encrypt → resumable multipart → restore, end to
                               # end against in-process fakes. Covers the archive→restore round trip,
                               # resume (skips parts already on S3), the content-drift guard, and the
                               # streaming memory bounds. No server, no network.
task ui:setup                  # bun install (once)
task ui:test && task ui:typecheck
```
There is no local S3 sandbox — the MinIO "dev sandbox" mode was retired 2026-07-14 (it proved nothing the
test suite doesn't prove deterministically, and carried a second identity path into the daemon). Run the
real thing against staging AWS instead: `task app:mac:run:staging-local`.

On a Mac: `task daemon:mac:bootstrap` (creds → Keychain + launchd install), `task daemon:mac:doctor`,
`task ui:mac:live` to dogfood the UI against the installed daemon, `task ui:mac:package` for the `.app`.

## Dev environment & gotchas (read before building — saves hours)
- **No Docker.** Native toolchain: Swift via `swiftly` (`task daemon:setup` is idempotent).
  New shells source `~/.local/share/swiftly/env.sh` — if
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
- **The daemon states its identity or refuses to start (2026-07-13).** `coldstored` needs Cognito config —
  without it it prints why and exits 2, rather than silently signing S3 calls as the shared all-access IAM
  user. (The `COLDSTORE_DEV_IDENTITY` local-dev alternative was retired 2026-07-14 with the MinIO sandbox:
  one identity path into the daemon, not two.) `task daemon:mac:install` fails fast if the Cognito handoff
  is missing. If you have
  a Mac data dir from before this, run **`task daemon:mac:reset:local` once** — the old machine-wide
  `coldstore.sqlite` is orphaned (and is the file that leaked one account's index to the next).
- **Inspect the journal:** it's **per signed-in user**, under the daemon's data root —
  `~/Library/Application Support/ColdStorage/users/<cognito-sub>/coldstore.sqlite`. There is no
  machine-wide journal.
- **libsodium is built from source on Linux** (`task daemon:setup`) — Ubuntu's apt 1.0.18 predates
  symbols swift-sodium needs; Apple platforms use the bundled XCFramework.

## License

**Source-available, not open source.** The repo ships under
[FSL-1.1-ALv2](./LICENSE) — the Functional Source License with an Apache-2.0 future license.
Read it, run it, change it, build on it; the one thing it forbids is using it to run a storage
service that competes with ColdStorage. **Each version auto-converts to Apache-2.0 two years
after release**, irrevocably.

Everything here is covered: the Swift daemon and engine, the Electron control panel, the
account backend, the marketing site, and the Terraform.

The customer-facing version is [`coldstorage.sh/source`](https://coldstorage.sh/source), which
points at `coldstorage/Sources/ColdStorageCore/Crypto.swift` and `ZeroKnowledgeKeys.swift` as
the two files where the "only you hold the key" claim is either true or it isn't — keep that
page honest if either file moves.

**That page must never call this open source** (`task copy:check:site` enforces it). Publishing
the code exists to make an encryption claim checkable; overstating the license is the one thing
that would poison it.
