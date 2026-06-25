# Daemon Module Split — keep most work in your dev container

> Goal: only the irreducibly-Apple parts touch a Mac. Everything else — including the **upload engine you care most about** — is portable Swift you build, test, and iterate on in your Linux dev container / CI, the way you already work.

## The principle
One boundary protocol separates a **portable core** from a thin **macOS adapter**. The core never imports an Apple-only framework, so it compiles and tests on Linux. The Mac supplies the Photos/TCC/launchd/signing parts behind the boundary.

## Where each piece lives

| Module | Home | Notes |
|---|---|---|
| **UploadEngine** (multipart, resume, concurrency, backpressure, retry) | **Core — container/CI** ✅ | the crown jewel; AWS SDK for Swift is cross-platform |
| **Journal** (SQLite/WAL) | **Core** ✅ | GRDB builds on Linux; test resume against MinIO/LocalStack |
| **Crypto** (envelope, AEAD frames) | **Core** ✅ | `swift-crypto` (already swapped into the spike) |
| **BlobPlanner** (batching, newest-first ordering) | **Core** ✅ | operates on abstract ingest items, not Photos directly |
| **IndexClient** (metadata store / backend API) | **Core** ✅ | plain networking |
| **Models / state machines** | **Core** ✅ | pure types |
| — boundary: `IngestSource` protocol — | | core depends only on this |
| **PhotoKitSource** (full-res originals, EXIF, Live Photo pairs) | **macOS adapter** 🍎 | `import Photos` |
| **FileSystemSource** (FSEvents folder watch) | **macOS adapter** 🍎 | portable fallback poller for tests |
| **TCC / permissions, Keychain, launchd glue, notifications** | **macOS adapter** 🍎 | platform-bound lifecycle + secrets |
| **codesign / notarize / package** | **Mac / macOS CI** 🍎 | release only |

## The boundary
```swift
// In Core — no Apple-only imports.
struct IngestItem {
    let id: String
    let relativePath: String
    let size: Int
    let contentHash: String         // SHA-256 — drives change/dedupe detection
    let metadata: [String: String]  // EXIF, album, Live-Photo pairing, etc.
    func open() throws -> ReadableStream
}

protocol IngestSource {
    func enumerate() async throws -> [IngestItem]
}
```
- **macOS:** `PhotoKitSource` + `FileSystemSource` implement `IngestSource`.
- **Linux/CI:** a `LocalDirSource` implements it from a folder of test files → the **entire upload pipeline runs in your container** (scan → batch → encrypt → resumable multipart → journal), exercised end-to-end without a Mac.

## SwiftPM shape
```
ColdStorage (package)
├─ Sources/ColdStorageCore/      # library, NO Apple-only imports → builds on Linux (engine, journal, crypto, control plane)
├─ Sources/ColdStorageMac/       # library, macOS-only (Photos, launchd, Keychain)
├─ Sources/coldstored/           # executable — the daemon (run loop + control socket); wires Core + Mac adapter
├─ Sources/coldstorectl/         # executable — control-socket client (send commands / watch events)
├─ Sources/coldstore-cli/        # executable — one-shot archive a folder (the upload-spike pipeline)
├─ Sources/coldstore-restore/    # executable — one-shot restore a file (re-run until it lands)
└─ Tests/ColdStorageCoreTests/   # run on Linux CI; the upload spike is now a Core integ test (swift-testing)
```
Gate the Mac target with `.when(platforms: [.macOS])` (or `#if canImport(Photos)`), so `swift build`/`swift test` of `ColdStorageCore` succeeds in the container.

## Dev-workflow mapping
- **In your container (daily):** iterate `ColdStorageCore` — upload engine, journal, resume, crypto — against **MinIO/LocalStack** (fast, offline, lets you script kills/failures). This is ~80% of the hard logic and your normal flow.
- **On a Mac (periodic):** build full `coldstored`, test PhotoKit/TCC/launchd, run true end-to-end, sign.
- **CI:** Linux runner for Core tests; macOS runner for the adapter + packaging/notarization.

## What this buys
The robustness work — the thing you said is V1-critical — lives where you're fast. The Mac is reserved for the genuinely platform-bound seam (proven cheaply by the [photos spike](./phase0-photos-spike/)) plus release. The [upload spike](./phase0-upload-spike/) is literally the seed of `ColdStorageCore`.
