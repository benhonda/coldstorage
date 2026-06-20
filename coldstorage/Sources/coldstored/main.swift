import Foundation
import AWSS3
import ColdStorageCore
#if canImport(Photos)
import Photos
import ColdStorageMac
#endif

// The macOS daemon (launchd LaunchAgent). Env-configured so it's also runnable in a Linux container
// for testing (folder sources only; PhotoKit is added on macOS when authorized).
//   COLDSTORE_BUCKET, COLDSTORE_ENDPOINT (MinIO), COLDSTORE_SOURCES=dir1:dir2  (one-time seed),
//   COLDSTORE_ONCE=1 (run once vs loop), COLDSTORE_INTERVAL=300, COLDSTORE_STATUS=status.json,
//   COLDSTORE_SOCKET=coldstored.sock (control plane), COLDSTORE_JOURNAL, COLDSTORE_KEK, COLDSTORE_STAGING
let env = ProcessInfo.processInfo.environment
let bucket = env["COLDSTORE_BUCKET"] ?? "coldstorage"
let endpoint = env["COLDSTORE_ENDPOINT"]
let folderRoots = (env["COLDSTORE_SOURCES"] ?? "").split(separator: ":").map { URL(fileURLWithPath: String($0)) }

let config = try await S3Client.S3ClientConfiguration(region: env["AWS_REGION"] ?? "us-east-1")
if let endpoint { config.endpoint = endpoint; config.forcePathStyle = true }
let client = S3Client(config: config)

let journal = try Journal(path: env["COLDSTORE_JOURNAL"] ?? "coldstore.sqlite")

// Seed folder sources from env into the journal registry (idempotent). After this, the registry is
// the SSOT — add/remove happens over the control socket, and survives restarts.
for root in folderRoots {
    let abs = root.standardizedFileURL.path
    try journal.addSource(SourceRow(id: abs, kind: .folder, path: abs))
}

// Platform sources: the Photos library on macOS, once authorized (TCC). Folders come from the registry.
var platformSources: [IngestSource] = []
#if canImport(Photos)
let photoStatus = await withCheckedContinuation { (c: CheckedContinuation<PHAuthorizationStatus, Never>) in
    PHPhotoLibrary.requestAuthorization(for: .readWrite) { c.resume(returning: $0) }
}
if photoStatus == .authorized || photoStatus == .limited {
    platformSources.append(PhotoKitSource())
    print("coldstored: Photos authorized — including the library")
} else {
    print("coldstored: Photos not authorized — folders only")
}
#endif

let engine = UploadEngine(
    journal: journal,
    store: S3Store(client: client, bucket: bucket, storageClass: endpoint != nil ? nil : .deepArchive),
    keys: LocalFileKEK(path: env["COLDSTORE_KEK"] ?? "dev-kek.bin"),
    stagingDir: URL(fileURLWithPath: env["COLDSTORE_STAGING"] ?? ".staging"))

let bus = EventBus()
let daemon = DaemonService(engine: engine, journal: journal, bus: bus,
                           statusPath: env["COLDSTORE_STATUS"] ?? "status.json",
                           platformSources: platformSources)

// Control plane: a local unix socket the UI/cli drives (getStatus, add/removeSource, triggerNow, …).
let socketPath = env["COLDSTORE_SOCKET"] ?? "coldstored.sock"
let server = ControlServer(path: socketPath, bus: bus) { req in await daemon.respond(to: req) }
try server.start()
print("coldstored: control socket at \(socketPath)")

#if canImport(CoreServices)
// FSEvents: re-scan promptly when a watched folder changes, instead of only on the interval.
let watcher = FolderWatcher { Task { await daemon.trigger() } }
watcher.start(paths: try journal.listSources().compactMap { $0.kind == .folder ? $0.path : nil })
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
