import Foundation
import AWSS3
import ColdStorageCore

// Restore one archived file, decrypt, verify, write it out.
//   coldstore-restore <fileId> <outPath> <bucket> [endpoint-url]
let args = CommandLine.arguments
guard args.count >= 4 else { FileHandle.standardError.write(Data("usage: coldstore-restore <fileId> <outPath> <bucket> [endpoint-url]\n".utf8)); exit(2) }
let fileId = args[1], outPath = args[2], bucket = args[3]
let endpoint = args.count >= 5 ? args[4] : nil

let config = try await S3Client.S3ClientConfiguration(region: ProcessInfo.processInfo.environment["AWS_REGION"] ?? "us-east-1")
if let endpoint { config.endpoint = endpoint; config.forcePathStyle = true }
let client = S3Client(config: config)

let restore = RestoreEngine(
    journal: try Journal(path: "coldstore.sqlite"),
    store: S3Store(client: client, bucket: bucket),
    keys: LocalFileKEK(path: "dev-kek.bin"))

try await restore.restore(fileId: fileId, to: URL(fileURLWithPath: outPath))
print("✅ restored '\(fileId)' → \(outPath) (decrypted + hash-verified)")
