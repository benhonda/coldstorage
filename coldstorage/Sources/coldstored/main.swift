import Foundation
import AWSS3
import ColdStorageCore
#if canImport(CoreServices)
import ColdStorageMac   // FolderWatcher (FSEvents). Also home of PhotoKitSource, for the future explicit photo-deposit path.
#endif

// The macOS daemon (launchd LaunchAgent). Env-configured so it's also runnable in a Linux container
// for testing (folder sources only; PhotoKit is added on macOS when authorized).
//   COLDSTORE_BUCKET, COLDSTORE_ENDPOINT (MinIO), COLDSTORE_SOURCES=dir1:dir2 (one-time seed, dev only),
//   COLDSTORE_ONCE=1 (run once vs loop), COLDSTORE_INTERVAL=300, COLDSTORE_SOCKET=coldstored.sock,
//   COLDSTORE_DATA_DIR=. — the ROOT of everything persisted. Per-user state (journal, staging,
//     status.json) lives at `<root>/users/<sub>/` and is opened at SIGN-IN, not here: at startup nobody is
//     signed in, so there is no journal for this file to open. That is the point — see UserSession.swift.
//   Identity — EXACTLY ONE is required, or the process exits(2):
//     COLDSTORE_COGNITO_IDENTITY_POOL_ID + COLDSTORE_COGNITO_USER_POOL_PROVIDER (multi-user prod; both
//       together), optional COLDSTORE_COGNITO_REGION (falls back to AWS_REGION — only needed if Cognito
//       and the vault live in different regions)
//     COLDSTORE_DEV_IDENTITY=<name> (local dev / MinIO), optional COLDSTORE_KEK to override the key path
let env = ProcessInfo.processInfo.environment
let bucket = env["COLDSTORE_BUCKET"] ?? "coldstorage"
let endpoint = env["COLDSTORE_ENDPOINT"]
let folderRoots = (env["COLDSTORE_SOURCES"] ?? "").split(separator: ":").map { URL(fileURLWithPath: String($0)) }

// Root of everything this daemon persists. Per-USER state (journal, staging, status.json) lives under
// `<dataRoot>/users/<sub>/` and is opened by `UserSession` at sign-in — never here, because at process
// start we do not yet know who the user is. That's the whole point: there is no machine-wide journal to
// leak. The socket stays at the root (it's a machine-level rendezvous, not user data).
let dataRoot = URL(fileURLWithPath: env["COLDSTORE_DATA_DIR"] ?? ".")

// ── Which daemon is this? EXACTLY ONE of two modes, and never by accident. ────────────────────────────
//
//   multi-user (Cognito configured) — the real product. Every S3 call signs as whoever is signed in over
//     the control socket (`authenticate`), and per-user state is opened for THAT user. Until sign-in the
//     daemon holds no session: no journal, no key, no prefix, nothing to serve.
//
//   local dev (COLDSTORE_DEV_IDENTITY set, and Cognito NOT configured) — MinIO / offline work. One eager
//     session named for the dev identity, seeded from the local file KEK so there is no unlock step.
//
// If NEITHER is configured we REFUSE TO START. That refusal is the point. This used to be an `else`
// branch: a daemon with no Cognito silently fell back to the default AWS credential chain — the dogfood
// IAM user, whose policy grants `blobs/*`, i.e. EVERY user's objects — and a flat `blobs` key prefix. On a
// single-operator machine that was fine. In a multi-user world it is a loaded gun: one blank env var in
// the launchd plist and the daemon comes up holding an all-access credential pointed at a shared
// namespace. A fallback that silently widens a security boundary is not a convenience (AVOID4); the
// mode is now stated, or the process exits.
func nonEmpty(_ key: String) -> String? { env[key].flatMap { $0.isEmpty ? nil : $0 } }

// Non-empty check (not just non-nil): the launchd plist always sets these two keys, blank when the
// handoff was never re-exported — that must read as "not configured", same as unset.
let cognitoPoolId = nonEmpty("COLDSTORE_COGNITO_IDENTITY_POOL_ID")
let cognitoProvider = nonEmpty("COLDSTORE_COGNITO_USER_POOL_PROVIDER")
let devIdentity = nonEmpty("COLDSTORE_DEV_IDENTITY")

let cognitoAuth: CognitoAuth?
let config: S3Client.S3ClientConfiguration
if let poolId = cognitoPoolId, let providerName = cognitoProvider {
    let cognitoRegion = env["COLDSTORE_COGNITO_REGION"] ?? env["AWS_REGION"] ?? "us-east-1"
    let auth = try CognitoAuth(identityPoolId: poolId, identityPoolRegion: cognitoRegion, userPoolProviderName: providerName)
    cognitoAuth = auth
    config = try await S3Client.S3ClientConfiguration(awsCredentialIdentityResolver: auth.resolver, region: cognitoRegion)
} else if devIdentity != nil {
    cognitoAuth = nil
    config = try await S3Client.S3ClientConfiguration(region: env["AWS_REGION"] ?? "us-east-1")
} else {
    FileHandle.standardError.write(Data("""
        coldstored: refusing to start — no identity configured.
          multi-user: set COLDSTORE_COGNITO_IDENTITY_POOL_ID + COLDSTORE_COGNITO_USER_POOL_PROVIDER
          local dev:  set COLDSTORE_DEV_IDENTITY=<name> (MinIO / offline only)
        Starting without either would sign S3 calls as the shared all-access IAM user, against a shared
        key prefix — see the mode note in main.swift.

        """.utf8))
    exit(2)
}
if let endpoint { config.endpoint = endpoint; config.forcePathStyle = true }
let client = S3Client(config: config)

// Platform sources: folders come from the journal registry. Photos are deliberately NOT a background
// source — auto-archiving the whole library is invasive and is explicitly rejected (product decision
// 2026-06-26). Photo ingest is EXPLICIT: the user picks specific photos to deposit and only those are
// archived, mirroring file deposit (ExplicitPathsSource). The OS grant may be full-library (one tap,
// less friction) but breadth of grant ≠ permission to slurp — we only ever read what was deposited.
// That deposit path will reuse the proven PhotoKitSource.stream(assetId:) (durable launchd TCC grant +
// full-res iCloud originals — see phase0-photos-spike) and needs the daemon binary to embed
// coldstored-Info.plist + be codesigned; it is not built yet, so the daemon archives folders + explicit
// file deposits only. See ui/DESIGN.md.
let platformSources: [IngestSource] = []

// Photo deposit IS wired (explicit-deposit only): the `depositPhotos` command resolves picked asset IDs
// to full-res originals via PhotoKit and archives only those. The resolver is Mac-only (PhotoKit); off
// macOS it's nil and the command reports photos-unavailable. NOTE: actual Photos access still needs the
// daemon binary to embed coldstored-Info.plist + be codesigned (recipe proven in phase0-photos-spike) —
// see daemon:mac:install. Until that lands, the resolver compiles + dispatches but PhotoKit will deny reads.
#if canImport(Photos)
let photoResolver: (any PhotoResolver)? = PhotoKitResolver()
#else
let photoResolver: (any PhotoResolver)? = nil
#endif

// Shared store + keys: the upload engine PUTs with them, the restore engine GETs/thaws + decrypts with
// them. storageClass only affects PUT, so sharing one store is correct (restore ignores it).
let store = S3Store(client: client, bucket: bucket, storageClass: endpoint != nil ? nil : .deepArchive)

// Sessions are built per signed-in user (see `UserSession`) — the journal, the staging dir, the status
// file and the MasterKey holder all hang off one, so none of them can outlive a sign-out.
//
// `canSelfThaw` mirrors what this daemon's credentials can actually DO, derived from the same signal every
// other multi-user seam uses, never configured separately:
//   - local dev → the IAM user from infra/coldstorage/.../iam.tf, which HAS s3:RestoreObject → thaws directly.
//   - multi-user → a customer's Cognito role, which deliberately does NOT (cognito.tf). The thaw is the
//     paid-retrieval hard gate; only the account backend can perform it (root RETRIEVAL.md).
let sessions = SessionFactory(dataRoot: dataRoot, store: store, canSelfThaw: cognitoAuth == nil)

// A multi-user daemon starts SIGNED OUT — no session until `authenticate`. A dev daemon has no sign-in
// step, so it gets its one session eagerly, seeded from the local file KEK (no unlock step, MinIO runs
// work exactly as before).
let initialSession: UserSession?
if let devIdentity {
    // Keyed by dev identity, so two dev identities on one machine don't share a key — the same rule the
    // real product follows (a real user's MasterKey is escrowed per `sub`). It sits at the data root rather
    // than inside the session dir only because the key must exist BEFORE the session that consumes it —
    // which means WE must ensure the root exists first (`UserSession` creates its own subdirectory, but by
    // then the key has already been written).
    try FileManager.default.createDirectory(at: dataRoot, withIntermediateDirectories: true)
    let kekPath = env["COLDSTORE_KEK"] ?? dataRoot.appendingPathComponent("dev-kek-\(devIdentity).bin").path
    let kek = try LocalFileKEK(path: kekPath).userKEK()
    let dev = try sessions.make(.dev(name: devIdentity), initialKey: kek)
    // Seed folder sources from env into the dev journal (idempotent). Dev-only: in multi-user there is no
    // journal at process start to seed INTO, and env-seeding one user's watched folders at boot is exactly
    // the kind of unscoped state this refactor exists to delete.
    for root in folderRoots {
        let abs = root.standardizedFileURL.path
        try dev.journal.addSource(SourceRow(id: abs, kind: .folder, path: abs,
                                            mountPath: URL(fileURLWithPath: abs).lastPathComponent))
    }
    initialSession = dev
} else {
    initialSession = nil
}

let bus = EventBus()
let daemon = DaemonService(bus: bus,
                           sessions: sessions,
                           platformSources: platformSources,
                           photoResolver: photoResolver,
                           cognitoAuth: cognitoAuth,
                           initialSession: initialSession)

// Control plane: a local unix socket the UI/cli drives (getStatus, add/removeSource, triggerNow, …).
let socketPath = env["COLDSTORE_SOCKET"] ?? "coldstored.sock"
let server = ControlServer(path: socketPath, bus: bus) { req in await daemon.respond(to: req) }
try server.start()
print("coldstored: control socket at \(socketPath)")

#if canImport(CoreServices)
// FSEvents: re-scan promptly when a watched folder changes, instead of only on the interval.
let watcher = FolderWatcher { Task { await daemon.trigger() } }
// The watched set comes from the DAEMON now (`watchedFolderPaths`), not from a journal this file holds —
// because signed out there is no journal, and the folders are whoever-is-signed-in's. Empty when signed
// out, so a signed-out daemon watches nothing at all.
watcher.start(paths: await daemon.watchedFolderPaths())
// Re-arm on registry changes AND on sign-in/sign-out: addSource/removeSource/pause/resume emit
// `sourcesChanged`, while authenticate/deauthenticate emit `filesChanged` — so a new user's folders are
// watched (and the previous user's are dropped) without a daemon restart. `setPaths` is a no-op when the
// resulting set is unchanged.
bus.subscribe { event in
    guard event.name == "sourcesChanged" || event.name == "filesChanged" else { return }
    Task { watcher.setPaths(await daemon.watchedFolderPaths()) }
}
#endif

if env["COLDSTORE_ONCE"] != nil {
    try await daemon.runOnce()
    server.stop()
    print("coldstored: one-shot run complete → \(initialSession?.statusPath ?? "(signed out — nothing to run)")")
} else {
    let interval = UInt64(env["COLDSTORE_INTERVAL"] ?? "300") ?? 300
    print("coldstored: starting archive loop (every \(interval)s)")
    try await daemon.runForever(intervalSeconds: interval)
}
