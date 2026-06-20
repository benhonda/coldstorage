import Foundation
import AWSS3
import ColdStorageCore

// Restore one archived file: thaw if needed, decrypt + verify, write it out.
//   coldstore-restore <fileId> <outPath> <bucket> [endpoint-url] [--tier standard|bulk|expedited]
// Deep Archive can't download directly — first run kicks off a thaw (hours); re-run to download.
// Exit 0 = restored to disk · 75 (EX_TEMPFAIL) = still thawing, re-run later · 2 = usage.
var args = CommandLine.arguments

// --tier <t> (default standard; Deep Archive supports standard/bulk only)
var tier = RestoreTier.standard
if let i = args.firstIndex(of: "--tier"), i + 1 < args.count {
    guard let t = RestoreTier(rawValue: args[i + 1].lowercased()) else {
        FileHandle.standardError.write(Data("bad --tier '\(args[i + 1])' (expected: standard | bulk | expedited)\n".utf8)); exit(2)
    }
    tier = t; args.removeSubrange(i ... i + 1)
}

guard args.count >= 4 else {
    FileHandle.standardError.write(Data("usage: coldstore-restore <fileId> <outPath> <bucket> [endpoint-url] [--tier standard|bulk|expedited]\n".utf8)); exit(2)
}
let fileId = args[1], outPath = args[2], bucket = args[3]
let endpoint = args.count >= 5 ? args[4] : nil

let config = try await S3Client.S3ClientConfiguration(region: ProcessInfo.processInfo.environment["AWS_REGION"] ?? "us-east-1")
if let endpoint { config.endpoint = endpoint; config.forcePathStyle = true }
let client = S3Client(config: config)

let restore = RestoreEngine(
    journal: try Journal(path: "coldstore.sqlite"),
    store: S3Store(client: client, bucket: bucket),
    keys: LocalFileKEK(path: "dev-kek.bin"))

switch try await restore.restore(fileId: fileId, to: URL(fileURLWithPath: outPath), tier: tier) {
case .restored:
    print("✅ restored '\(fileId)' → \(outPath) (decrypted + hash-verified)")
case .thawRequested(let t):
    print("🧊 thaw requested for '\(fileId)' (tier: \(t.rawValue), typical wait \(t.typicalWait)).")
    print("   Re-run this command later to download once it's ready.")
    exit(75)   // EX_TEMPFAIL
case .thawInProgress:
    print("⏳ '\(fileId)' is still thawing — check back later, then re-run to download.")
    exit(75)   // EX_TEMPFAIL
}
