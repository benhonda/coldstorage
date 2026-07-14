import Foundation
import AWSS3
import ColdStorageCore
#if canImport(CoreServices)
import ColdStorageMac   // FolderWatcher (FSEvents). Also home of PhotoKitSource, for the future explicit photo-deposit path.
#endif

// The macOS daemon (launchd LaunchAgent). Env-configured so it's also runnable in a Linux container
// for testing (folder sources only; PhotoKit is added on macOS when authorized).
//   COLDSTORE_BUCKET, COLDSTORE_ONCE=1 (run once vs loop), COLDSTORE_INTERVAL=300,
//   COLDSTORE_SOCKET=coldstored.sock,
//   COLDSTORE_DATA_DIR=. — the ROOT of everything persisted. Per-user state (journal, scratch,
//     status.json) lives at `<root>/users/<sub>/` and is opened at SIGN-IN, not here: at startup nobody is
//     signed in, so there is no journal for this file to open. That is the point — see UserSession.swift.
//   Identity — REQUIRED, or the process exits(2):
//     COLDSTORE_COGNITO_IDENTITY_POOL_ID + COLDSTORE_COGNITO_USER_POOL_PROVIDER (both together),
//       optional COLDSTORE_COGNITO_REGION (falls back to AWS_REGION — only needed if Cognito and the
//       vault live in different regions)
let env = ProcessInfo.processInfo.environment
let bucket = env["COLDSTORE_BUCKET"] ?? "coldstorage"

// Root of everything this daemon persists. Per-USER state (journal, scratch, status.json) lives under
// `<dataRoot>/users/<sub>/` and is opened by `UserSession` at sign-in — never here, because at process
// start we do not yet know who the user is. That's the whole point: there is no machine-wide journal to
// leak. The socket stays at the root (it's a machine-level rendezvous, not user data).
let dataRoot = URL(fileURLWithPath: env["COLDSTORE_DATA_DIR"] ?? ".")

// ── Identity: Cognito, or the process does not start. ─────────────────────────────────────────────────
//
// Every S3 call signs as whoever is signed in over the control socket (`authenticate`), and per-user state
// is opened for THAT user. Until sign-in the daemon holds no session: no journal, no key, no prefix,
// nothing to serve.
//
// There is deliberately NO other mode. A daemon with no Cognito once fell back to the default AWS
// credential chain — the dogfood IAM user, whose policy grants `blobs/*`, i.e. EVERY user's objects —
// against a flat `blobs` prefix. One blank env var in the launchd plist and it would come up holding an
// all-access credential pointed at a shared namespace. A fallback that silently widens a security boundary
// is not a convenience (AVOID4). (A `COLDSTORE_DEV_IDENTITY` sandbox mode also lived here, for the local
// MinIO loop; MinIO is gone — the pipeline is proven by the test suite, and the app runs against real
// staging AWS — so the mode went with it rather than lingering as a second way in.)
func nonEmpty(_ key: String) -> String? { env[key].flatMap { $0.isEmpty ? nil : $0 } }

// Non-empty check (not just non-nil): the launchd plist always sets these two keys, blank when the
// handoff was never re-exported — that must read as "not configured", same as unset.
let cognitoPoolId = nonEmpty("COLDSTORE_COGNITO_IDENTITY_POOL_ID")
let cognitoProvider = nonEmpty("COLDSTORE_COGNITO_USER_POOL_PROVIDER")

guard let cognitoPoolId, let cognitoProvider else {
    FileHandle.standardError.write(Data("""
        coldstored: refusing to start — no identity configured.
          set COLDSTORE_COGNITO_IDENTITY_POOL_ID + COLDSTORE_COGNITO_USER_POOL_PROVIDER
        Starting without them would sign S3 calls as the shared all-access IAM user, against a shared
        key prefix — see the identity note in main.swift.

        """.utf8))
    exit(2)
}
let cognitoRegion = env["COLDSTORE_COGNITO_REGION"] ?? env["AWS_REGION"] ?? "us-east-1"
let cognitoAuth = try CognitoAuth(identityPoolId: cognitoPoolId, identityPoolRegion: cognitoRegion,
                                  userPoolProviderName: cognitoProvider)
let config = try await S3Client.S3ClientConfiguration(awsCredentialIdentityResolver: cognitoAuth.resolver,
                                                      region: cognitoRegion)
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
let store = S3Store(client: client, bucket: bucket, storageClass: .deepArchive)

// Sessions are built per signed-in user (see `UserSession`) — the journal, the scratch dir, the status
// file and the MasterKey holder all hang off one, so none of them can outlive a sign-out.
//
// `canSelfThaw: false` — a customer's Cognito role deliberately lacks `s3:RestoreObject` (cognito.tf). The
// thaw is the paid-retrieval hard gate; only the account backend can perform it (root RETRIEVAL.md).
let sessions = SessionFactory(dataRoot: dataRoot, store: store, canSelfThaw: false)

// The daemon starts SIGNED OUT — no session until `authenticate` over the control socket. There is no
// eager session to build here, because at process start we do not know who the user is.

let bus = EventBus()
let daemon = DaemonService(bus: bus,
                           sessions: sessions,
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
    print("coldstored: one-shot run complete")
} else {
    let interval = UInt64(env["COLDSTORE_INTERVAL"] ?? "300") ?? 300
    print("coldstored: starting archive loop (every \(interval)s)")
    try await daemon.runForever(intervalSeconds: interval)
}
