import Foundation
import AWSS3
import ColdStorageCore

// Portable pipeline runner — archives a local dir to S3/MinIO. Runs in your dev container.
//   coldstore-cli <dir> <bucket> [endpoint-url]
// Creds come from the env (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION).
let args = CommandLine.arguments
guard args.count >= 3 else { FileHandle.standardError.write(Data("usage: coldstore-cli <dir> <bucket> [endpoint-url]\n".utf8)); exit(2) }
let dir = URL(fileURLWithPath: args[1])
let bucket = args[2]
let endpoint = args.count >= 4 ? args[3] : nil

// NOTE: config property names (endpoint / forcePathStyle) may vary by SDK version — adjust on first build.
let config = try await S3Client.S3ClientConfiguration(region: ProcessInfo.processInfo.environment["AWS_REGION"] ?? "us-east-1")
if let endpoint { config.endpoint = endpoint; config.forcePathStyle = true }   // MinIO/LocalStack
let client = S3Client(config: config)

let engine = UploadEngine(
    source: LocalDirSource(root: dir),
    journal: try Journal(path: "coldstore.sqlite"),
    store: S3Store(client: client, bucket: bucket, storageClass: endpoint != nil ? nil : .deepArchive),
    keys: LocalFileKEK(path: "dev-kek.bin"),
    stagingDir: URL(fileURLWithPath: ".staging"))

try await engine.run()
print("✅ archived \(dir.path) → s3://\(bucket)  (kill it mid-run and re-run — it resumes)")
