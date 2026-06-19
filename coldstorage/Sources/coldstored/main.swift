import Foundation
import AWSS3
import ColdStorageCore
#if canImport(Photos)
import Photos
import ColdStorageMac
#endif

// The macOS daemon (launchd LaunchAgent). Env-configured so it's also runnable in a Linux container
// for testing (folder sources only; PhotoKit is added on macOS when authorized).
//   COLDSTORE_BUCKET, COLDSTORE_ENDPOINT (MinIO), COLDSTORE_SOURCES=dir1:dir2,
//   COLDSTORE_ONCE=1 (run once vs loop), COLDSTORE_INTERVAL=300, COLDSTORE_STATUS=status.json
let env = ProcessInfo.processInfo.environment
let bucket = env["COLDSTORE_BUCKET"] ?? "coldstorage"
let endpoint = env["COLDSTORE_ENDPOINT"]
let folderRoots = (env["COLDSTORE_SOURCES"] ?? "").split(separator: ":").map { URL(fileURLWithPath: String($0)) }

let config = try await S3Client.S3ClientConfiguration(region: env["AWS_REGION"] ?? "us-east-1")
if let endpoint { config.endpoint = endpoint; config.forcePathStyle = true }
let client = S3Client(config: config)

var sources: [IngestSource] = folderRoots.map { LocalDirSource(root: $0) }
#if canImport(Photos)
let status = await withCheckedContinuation { (c: CheckedContinuation<PHAuthorizationStatus, Never>) in
    PHPhotoLibrary.requestAuthorization(for: .readWrite) { c.resume(returning: $0) }
}
if status == .authorized || status == .limited {
    sources.append(PhotoKitSource())
    print("coldstored: Photos authorized — including the library")
} else {
    print("coldstored: Photos not authorized — folders only")
}
#endif

let journal = try Journal(path: env["COLDSTORE_JOURNAL"] ?? "coldstore.sqlite")
let engine = UploadEngine(
    source: MultiSource(sources),
    journal: journal,
    store: S3Store(client: client, bucket: bucket, storageClass: endpoint != nil ? nil : .deepArchive),
    keys: LocalFileKEK(path: env["COLDSTORE_KEK"] ?? "dev-kek.bin"),
    stagingDir: URL(fileURLWithPath: env["COLDSTORE_STAGING"] ?? ".staging"))
let daemon = DaemonService(engine: engine, journal: journal, statusPath: env["COLDSTORE_STATUS"] ?? "status.json")

if env["COLDSTORE_ONCE"] != nil {
    try await daemon.runOnce()
    print("coldstored: one-shot run complete → \(env["COLDSTORE_STATUS"] ?? "status.json")")
} else {
    let interval = UInt64(env["COLDSTORE_INTERVAL"] ?? "300") ?? 300
    print("coldstored: starting archive loop (every \(interval)s)")
    try await daemon.runForever(intervalSeconds: interval)
}
