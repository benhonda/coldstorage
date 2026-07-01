import Foundation
import AWSS3
import ColdStorageCore
#if canImport(CoreServices)
import ColdStorageMac   // FolderWatcher (FSEvents). Also home of PhotoKitSource, for the future explicit photo-deposit path.
#endif

// The macOS daemon (launchd LaunchAgent). Env-configured so it's also runnable in a Linux container
// for testing (folder sources only; PhotoKit is added on macOS when authorized).
//   COLDSTORE_BUCKET, COLDSTORE_ENDPOINT (MinIO), COLDSTORE_SOURCES=dir1:dir2  (one-time seed),
//   COLDSTORE_ONCE=1 (run once vs loop), COLDSTORE_INTERVAL=300, COLDSTORE_STATUS=status.json,
//   COLDSTORE_SOCKET=coldstored.sock (control plane), COLDSTORE_JOURNAL, COLDSTORE_KEK, COLDSTORE_STAGING
//   COLDSTORE_COGNITO_IDENTITY_POOL_ID + COLDSTORE_COGNITO_USER_POOL_PROVIDER (multi-user prod; both
//   required together, empty/unset ⇒ today's single-operator dogfood mode), optional COLDSTORE_COGNITO_REGION
//   (falls back to AWS_REGION — only needed if Cognito and the vault ever live in different regions)
let env = ProcessInfo.processInfo.environment
let bucket = env["COLDSTORE_BUCKET"] ?? "coldstorage"
let endpoint = env["COLDSTORE_ENDPOINT"]
let folderRoots = (env["COLDSTORE_SOURCES"] ?? "").split(separator: ":").map { URL(fileURLWithPath: String($0)) }

// Cognito (multi-user prod, PROD.md Phase 2) is opt-in: unset ⇒ the default AWS credential chain (the
// scoped IAM user via `daemon:bootstrap`'s profile/Keychain) and the "blobs" keyPrefix, exactly as today.
// Set ⇒ every S3 call signs as whoever is signed in over the control socket (`authenticate` command); until
// that succeeds, S3 calls fail clean on Cognito's own auth error — the identity pool grants no
// unauthenticated role (infra/coldstorage/modules/stack/cognito.tf: allow_unauthenticated_identities = false).
// Non-empty check (not just non-nil): the launchd plist always sets these two keys, blank when the
// handoff predates Phase 2c or was never re-exported — that must read as "not configured", same as unset.
func nonEmpty(_ key: String) -> String? { env[key].flatMap { $0.isEmpty ? nil : $0 } }
let cognitoAuth: CognitoAuth?
let config: S3Client.S3ClientConfiguration
if let poolId = nonEmpty("COLDSTORE_COGNITO_IDENTITY_POOL_ID"), let providerName = nonEmpty("COLDSTORE_COGNITO_USER_POOL_PROVIDER") {
    let cognitoRegion = env["COLDSTORE_COGNITO_REGION"] ?? env["AWS_REGION"] ?? "us-east-1"
    let auth = try CognitoAuth(identityPoolId: poolId, identityPoolRegion: cognitoRegion, userPoolProviderName: providerName)
    cognitoAuth = auth
    config = try await S3Client.S3ClientConfiguration(awsCredentialIdentityResolver: auth.resolver, region: cognitoRegion)
} else {
    cognitoAuth = nil
    config = try await S3Client.S3ClientConfiguration(region: env["AWS_REGION"] ?? "us-east-1")
}
if let endpoint { config.endpoint = endpoint; config.forcePathStyle = true }
let client = S3Client(config: config)

let journal = try Journal(path: env["COLDSTORE_JOURNAL"] ?? "coldstore.sqlite")

// Seed folder sources from env into the journal registry (idempotent). After this, the registry is
// the SSOT — add/remove happens over the control socket, and survives restarts.
for root in folderRoots {
    let abs = root.standardizedFileURL.path
    // Env-seeded folders mount under their basename (same default as an addSource over the socket).
    try journal.addSource(SourceRow(id: abs, kind: .folder, path: abs, mountPath: URL(fileURLWithPath: abs).lastPathComponent))
}

// Platform sources: folders come from the journal registry. Photos are deliberately NOT a background
// source — auto-archiving the whole library is invasive and is explicitly rejected (product decision
// 2026-06-26). Photo ingest is EXPLICIT: the user picks specific photos to deposit and only those are
// archived, mirroring file deposit (ExplicitPathsSource). The OS grant may be full-library (one tap,
// less friction) but breadth of grant ≠ permission to slurp — we only ever read what was deposited.
// That deposit path will reuse the proven PhotoKitSource.stream(assetId:) (durable launchd TCC grant +
// full-res iCloud originals — see phase0-photos-spike) and needs the daemon binary to embed
// coldstored-Info.plist + be codesigned; it is not built yet, so the daemon archives folders + explicit
// file deposits only. See ROADMAP / ELECTRON-UI-DESIGN.md.
let platformSources: [IngestSource] = []

// Photo deposit IS wired (explicit-deposit only): the `depositPhotos` command resolves picked asset IDs
// to full-res originals via PhotoKit and archives only those. The resolver is Mac-only (PhotoKit); off
// macOS it's nil and the command reports photos-unavailable. NOTE: actual Photos access still needs the
// daemon binary to embed coldstored-Info.plist + be codesigned (recipe proven in phase0-photos-spike) —
// see daemon:install. Until that lands, the resolver compiles + dispatches but PhotoKit will deny reads.
#if canImport(Photos)
let photoResolver: (any PhotoResolver)? = PhotoKitResolver()
#else
let photoResolver: (any PhotoResolver)? = nil
#endif

// Shared store + keys: the upload engine PUTs with them, the restore engine GETs/thaws + decrypts with
// them. storageClass only affects PUT, so sharing one store is correct (restore ignores it).
let store = S3Store(client: client, bucket: bucket, storageClass: endpoint != nil ? nil : .deepArchive)
let keys = LocalFileKEK(path: env["COLDSTORE_KEK"] ?? "dev-kek.bin")

let engine = UploadEngine(
    journal: journal, store: store, keys: keys,
    stagingDir: URL(fileURLWithPath: env["COLDSTORE_STAGING"] ?? ".staging"))
let restoreEngine = RestoreEngine(journal: journal, store: store, keys: keys)

let bus = EventBus()
let daemon = DaemonService(engine: engine, restoreEngine: restoreEngine, journal: journal, bus: bus,
                           statusPath: env["COLDSTORE_STATUS"] ?? "status.json",
                           platformSources: platformSources,
                           photoResolver: photoResolver,
                           cognitoAuth: cognitoAuth)

// Control plane: a local unix socket the UI/cli drives (getStatus, add/removeSource, triggerNow, …).
let socketPath = env["COLDSTORE_SOCKET"] ?? "coldstored.sock"
let server = ControlServer(path: socketPath, bus: bus) { req in await daemon.respond(to: req) }
try server.start()
print("coldstored: control socket at \(socketPath)")

#if canImport(CoreServices)
// FSEvents: re-scan promptly when a watched folder changes, instead of only on the interval.
let watcher = FolderWatcher { Task { await daemon.trigger() } }
// The set of folders to watch = active (non-paused) folder sources — same predicate the run loop scans
// by (DaemonService.currentSource), so a paused/"Not watching" folder doesn't wake the daemon either.
@Sendable func watchedFolderPaths() -> [String] {
    ((try? journal.listSources()) ?? []).compactMap { $0.kind == .folder && !$0.paused ? $0.path : nil }
}
watcher.start(paths: watchedFolderPaths())
// Re-arm on registry changes: addSource/removeSource/pause/resume all emit `sourcesChanged`, so a newly
// added (or unpaused) folder is FSEvents-watched without a daemon restart — and a removed/paused one
// stops. `setPaths` is a no-op when the resulting set is unchanged.
bus.subscribe { event in
    guard event.name == "sourcesChanged" else { return }
    watcher.setPaths(watchedFolderPaths())
}
#endif

if env["COLDSTORE_ONCE"] != nil {
    try await daemon.runOnce()
    server.stop()
    print("coldstored: one-shot run complete → \(env["COLDSTORE_STATUS"] ?? "status.json")")
} else {
    let interval = UInt64(env["COLDSTORE_INTERVAL"] ?? "300") ?? 300
    print("coldstored: starting archive loop (every \(interval)s)")
    try await daemon.runForever(intervalSeconds: interval)
}
