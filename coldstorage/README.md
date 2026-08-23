# ColdStorage daemon

The real foundation (supersedes the `phase0-*` spikes). A portable core does scan → plan → encrypt →
resumable multipart → verify → journal; the macOS adapter supplies PhotoKit behind one boundary. Built
to the four pillars: simple, best-practice, DRY, type-safe.

## Layout
```
Sources/ColdStorageCore/   # portable — builds/tests on Linux + macOS
  Models, IngestSource, LocalDirSource, Crypto, BlobPlanner, Journal, S3Store, UploadEngine, RestoreEngine
  ExplicitPathsSource, PhotoResolver/PhotoDepositSource   # ad-hoc deposit sources (files / picked photos)
  DaemonService            # the run loop + command surface (registry-driven, wakeable, paused/running)
  EventBus, ControlProtocol, UnixSocket, ControlServer, ControlClient   # the unix-socket control plane
Sources/ColdStorageMac/    # macOS-only adapter (PhotoKitSource + PhotoKitResolver, FolderWatcher), canImport-guarded
Sources/coldstorectl/      # thin client over the daemon control socket (getStatus, addSource, watch, …)
Sources/coldstore-photo-picker/  # macOS native PHPickerViewController helper → prints picked {id,name} (option B)
Sources/coldstored/        # daemon entrypoint — wires engine + EventBus + ControlServer (+ FSEvents on Mac)
launchd/                   # plist template + coldstored-Info.plist (TCC identity for Photos); task daemon:mac:install
Tests/                     # Core tests (swift-testing — NOT XCTest; XCTest deadlocks on Linux, see the root README gotchas)
```

## Run the whole pipeline (native — no Docker, no Mac)
Driven from the **root Taskfile**. From the repo root:
```sh
task daemon:setup        # one-time: Swift toolchain + libsodium (idempotent)
task daemon:build:dev    # debug build; first build fetches deps
task daemon:test         # the Core suite — the pipeline, end to end, against in-process fakes
```
`daemon:test` is where the pipeline is actually proven: scan → encrypt → resumable multipart → **restore**,
byte-for-byte, plus resume (parts already on S3 are generated but not re-sent), the content-drift guard, and
the streaming memory bounds. No server, no network, runs on Linux/CI.

> **There is no local S3 sandbox.** The MinIO dev-sandbox mode was retired 2026-07-14 along with the
> `COLDSTORE_DEV_IDENTITY` identity path and the `coldstore-cli` / `coldstore-restore` runners: it proved
> nothing the test suite doesn't prove deterministically, while carrying a second identity mode into a
> security-sensitive daemon. Run the real thing against staging AWS: `task app:mac:run:staging-local`.

## Drive the daemon over its control socket
The installed launchd daemon (`task daemon:mac:bootstrap`) is the only daemon there is. Drive it with:
```sh
task daemon:mac:live -- getStatus            # counts, sources, paused/running, permanentlyFailedBlobs
task daemon:mac:live -- addSource path=/abs/dir
task daemon:mac:live -- watch                # live event stream
```
A failing blob is **isolated**, not fatal: the run continues, a `blobFailed{blob,kind,message,paths}` event
is pushed (`paths` = newline-joined relativePaths of the files in the blob), and a *permanent* fault
(config/auth — e.g. `InvalidStorageClass`/`NoSuchBucket`) is skipped on later passes (and counted in
`getStatus.permanentlyFailedBlobs`) so the daemon doesn't re-stage a doomed blob each interval. A permanent
fault also marks its files `failed` in the journal (`Journal.markFilesFailed`), so `listFiles` returns
`failed` and the UI's ⚠ survives a refresh/restart. Transient faults are already retried by the AWS SDK
before they reach us.
The **signed-in user's journal is the SSOT for sources** — add/remove via the socket survives restarts
(`COLDSTORE_SOURCES` is only a one-time seed, dev-identity only). The socket is `0600` (owner-only).
On macOS the full setup is two task runs:
`task tf:coldstorage:creds-export` (in the devcontainer — TF config outputs → a gitignored handoff file over
the bind mount) then `task daemon:mac:bootstrap` (renders the LaunchAgent plist (RunAtLoad + KeepAlive) and
bootstraps it). `task daemon:mac:doctor` health-checks it; `daemon:mac:uninstall` removes it.
**There is no credential step.** The daemon holds no long-lived AWS key: it exchanges the signed-in user's
Cognito token for short-lived STS credentials scoped to that user's own `blobs/<identity-id>/` prefix, so the
handoff file carries public client config only. (Until 2026-07-27 this seeded an IAM secret into the login
Keychain behind a `credential_process` helper — that user and its key are deleted; see `/MIGRATION.md`.)

The server runs each command's async handler **off** the connection's read thread (no semaphore bridge —
that was a forward-progress hazard); writes per connection are serialized. Client API: `ControlClient(path:
readTimeout:)` — pass a `readTimeout` (seconds) for request/response calls so a stalled daemon fails fast;
omit it for a live event tail (`watch`), which blocks indefinitely by design. A UI is just a long-lived
`ControlClient`. **Non-Swift clients** (the Electron UI) speak the same JSONL protocol directly over the
socket — `ControlProtocol.swift` is the wire contract; see [`../ui/DESIGN.md`](../ui/DESIGN.md).

## Identity + on-disk state (env)
`coldstored` acts as **exactly one user at a time, or none** (`UserSession` — see
[`DESIGN.md`](./DESIGN.md) §2), so it has to be *told* who it is. It needs **exactly one** of the two
identity modes below and **refuses to start** (`exit 2`) with neither — there is no silent fallback,
because that fallback signed every S3 call as the shared all-access IAM user against a shared key
prefix. Signed out, the daemon has no journal, no key and no prefix: reads answer empty, mutations
throw *"not signed in"*.

| Env | What |
|---|---|
| `COLDSTORE_COGNITO_IDENTITY_POOL_ID` + `COLDSTORE_COGNITO_USER_POOL_PROVIDER` | **multi-user** (the real product) — starts signed out; the app's `authenticate` opens the session. Optional `COLDSTORE_COGNITO_REGION` (falls back to `AWS_REGION`). |
| `COLDSTORE_DATA_DIR` | the **root** everything persists under: `<root>/users/<sub>/{coldstore.sqlite, scratch/, status.json}`, opened at sign-in. There is no machine-wide journal, so there is no journal path to configure — this one root **replaces `COLDSTORE_JOURNAL` / `COLDSTORE_STAGING` / `COLDSTORE_STATUS` / `COLDSTORE_KEK`**. |
| `COLDSTORE_SOCKET` | the control socket — the one machine-level path (a rendezvous, not user data). |

Also: `COLDSTORE_BUCKET` · `COLDSTORE_INTERVAL` (default 300s) · `COLDSTORE_ONCE=1` (one pass, don't loop).

## Get a file back (restore)
```sh
task daemon:mac:live -- restore file=<fileId> out=/tmp/got.bin   # fileId = the relative path shown at archive time
```
One engine (`RestoreEngine`), reached through the daemon's `restore` control command — so the UI restores
over the same socket it watches. Idempotent — re-run
until the bytes land. Over IPC the response carries `state` (`restored` | `thawRequested` | `thawInProgress`)
plus the quoted `typicalWait` while thawing, and a `restore*` event is pushed to live watchers.
Restore is **idempotent and self-progressing** — re-run the same command until it lands:
- **STANDARD** (and `GLACIER_IR`): downloads, decrypts, hash-verifies, writes → exit `0`.
- **Deep Archive**: the first run issues a Glacier **thaw** (`RestoreObject`) and exits `75` (`EX_TEMPFAIL`);
  retrieval takes ~12 h (`--tier standard`) or ~48 h (`--tier bulk`). Re-run later → it downloads once ready.

`RestoreEngine.restore` returns `.restored / .thawRequested / .thawInProgress`; the thaw decision (`ThawState`)
reads the object's real storage class + `x-amz-restore` header from `HeadObject`, so it's correct regardless
of how we stored it. The decision logic is unit-tested (`ThawStateTests`); the live Deep Archive thaw can only
be exercised against real AWS.

## How robustness works (the crown jewel)
- **Deterministic encryption** — per-blob DEK + AES-GCM frames with counter nonces → a sealed blob is
  byte-reproducible, so re-encrypting on resume yields identical parts whose ETags match what's already up.
- **Nothing is written to disk** — the engine encrypts straight into the 64 MiB multipart parts, holding only
  the part in flight. Backing up a 40 GB video needs 40 GB of *upload*, not 40 GB of free space.
- **A changed source is rejected, not archived** — the plaintext SHA-256 is re-checked against what the scan
  measured, so a file edited mid-upload fails its blob instead of silently storing bytes that never existed.
- **Journal (SQLite/WAL)** — every part/blob/file transition committed; a crash leaves a resumable state.
- **`ListParts` reconcile** — S3 is the truth on restart; done parts are skipped.
- **Layered integrity** — plaintext SHA-256 per file + per-part SHA-256 declared at `CreateMultipartUpload`
  (so S3 stores/validates) + `HeadObject` verify. "Archived" = verified, never "PUT 200".
- **Newest/most-precious-first** planning so recent + favorites land fast.

## Known gaps

- **Photos hash on `localIdentifier`, not plaintext.** Integrity is unaffected — the content hash is
  computed from real bytes at archive time — but a true pre-pass hash would dedup re-deposits properly.
- **The engine is correct-but-sequential across blobs.** No cross-blob concurrency or adaptive
  throughput yet, and the poison-blob skip-list is in-memory, so it doesn't survive a restart.
- **No R2 bucket** for photo thumbnails or cross-device index portability. The browse *tree* is
  journal-backed and needs none; thumbnails and a second device do.
- `S3ClientConfiguration`/`*Input` deprecation warnings (the SDK moved to `S3ClientConfig`) — noise, not
  a bug.

UI-lane gaps live in [`../ui/DESIGN.md`](../ui/DESIGN.md); the launch punch list is in
[`../PROD.md`](../PROD.md).
