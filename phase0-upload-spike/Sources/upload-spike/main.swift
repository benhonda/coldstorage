import Foundation
import AWSS3
import Smithy        // ByteStream lives here in aws-sdk-swift 1.x; if it doesn't resolve, try `import ClientRuntime`
import Crypto        // swift-crypto: same SHA256 API as CryptoKit, runs on Linux + macOS

// ─────────────────────────────────────────────────────────────────────────────
// Phase 0 spike — journal-backed, kill-resumable S3 multipart upload to Deep Archive.
//
// What it proves:
//   • a hard kill (Ctrl-C / kill -9) mid-upload loses nothing
//   • on restart we reconcile against S3 (ListParts = truth), skip done parts, finish
//   • per-part SHA-256 is declared at CreateMultipartUpload (the gotcha) so S3 stores+validates it
//
// NOTE: AWS SDK for Swift inputs are *generated* — the initializer label set is stable but
// argument ORDER follows the generated memberwise init. If the compiler complains, reorder to
// match your installed version; the field names below are correct.
// ─────────────────────────────────────────────────────────────────────────────

let args = CommandLine.arguments
guard args.count >= 3 else {
    FileHandle.standardError.write(Data("usage: upload-spike <bucket> <file-path> [region]\n".utf8))
    exit(2)
}
let bucket = args[1]
let filePath = args[2]
let region = args.count >= 4 ? args[3] : "us-east-1"
let key = "spike/" + (filePath as NSString).lastPathComponent
let partSize = 16 * 1024 * 1024   // 16 MiB → lots of parts on a 256 MiB file = a clear resume demo
let delayMs = Int(ProcessInfo.processInfo.environment["SPIKE_DELAY_MS"] ?? "0") ?? 0  // slow it down to make killing easy

let attrs = try FileManager.default.attributesOfItem(atPath: filePath)
let fileSize = (attrs[.size] as? NSNumber)?.intValue ?? 0
guard fileSize > 0 else { print("empty/missing file"); exit(1) }
let totalParts = (fileSize + partSize - 1) / partSize

func sha256Base64(_ data: Data) -> String { Data(SHA256.hash(data: data)).base64EncodedString() }

let client = try await S3Client(region: region)

// Load or start the journal.
var journal = UploadJournal.load()
    ?? UploadJournal(bucket: bucket, key: key, fileSize: fileSize, partSize: partSize, uploadId: nil, parts: [])
guard journal.key == key, journal.fileSize == fileSize else {
    print("Journal is for a different file — delete \(UploadJournal.path) to start fresh."); exit(1)
}

// 1. Ensure an uploadId (create on first run, reuse on resume).
let uploadId: String
if let existing = journal.uploadId {
    uploadId = existing
    print("↻ Resuming upload \(existing.prefix(12))… — reconciling with S3")
} else {
    let out = try await client.createMultipartUpload(input: CreateMultipartUploadInput(
        bucket: bucket,
        checksumAlgorithm: .sha256,        // ← declare HERE or S3 silently won't store per-part checksums
        key: key,
        storageClass: .deepArchive
    ))
    uploadId = out.uploadId!
    journal.uploadId = uploadId
    try journal.save()
    print("⬆︎ Started multipart \(uploadId.prefix(12))…  s3://\(bucket)/\(key)  (\(totalParts) parts)")
}

// 2. Reconcile completed parts from S3 — the crash-window closer. Trust S3, not just the journal.
var done: [Int: PartRecord] = [:]
let listed = try await client.listParts(input: ListPartsInput(bucket: bucket, key: key, uploadId: uploadId))
for p in listed.parts ?? [] {
    if let n = p.partNumber, let etag = p.eTag {
        done[n] = PartRecord(partNumber: n, eTag: etag, checksumSHA256: p.checksumSHA256 ?? "")
    }
}
print("✓ \(done.count)/\(totalParts) parts already on S3 — skipping those")

// 3. Upload whatever's missing. Journal each part durably BEFORE moving on.
let fh = try FileHandle(forReadingFrom: URL(fileURLWithPath: filePath))
defer { try? fh.close() }
for n in 1...totalParts {
    if done[n] != nil { continue }
    try fh.seek(toOffset: UInt64((n - 1) * partSize))
    let data = (try fh.read(upToCount: partSize)) ?? Data()
    let checksum = sha256Base64(data)
    let out = try await client.uploadPart(input: UploadPartInput(
        body: .data(data),
        bucket: bucket,
        checksumSHA256: checksum,
        contentLength: data.count,
        key: key,
        partNumber: n,
        uploadId: uploadId
    ))
    done[n] = PartRecord(partNumber: n, eTag: out.eTag ?? "", checksumSHA256: checksum)
    journal.parts = done.values.sorted { $0.partNumber < $1.partNumber }
    try journal.save()   // ← kill the process right after this line and you lose nothing
    print("  part \(n)/\(totalParts) ✓ uploaded + journaled")
    if delayMs > 0 { try await Task.sleep(for: .milliseconds(delayMs)) }
}

// 4. Complete.
let completedParts = done.values.sorted { $0.partNumber < $1.partNumber }.map {
    S3ClientTypes.CompletedPart(checksumSHA256: $0.checksumSHA256, eTag: $0.eTag, partNumber: $0.partNumber)
}
_ = try await client.completeMultipartUpload(input: CompleteMultipartUploadInput(
    bucket: bucket,
    key: key,
    multipartUpload: S3ClientTypes.CompletedMultipartUpload(parts: completedParts),
    uploadId: uploadId
))
print("✅ Completed \(totalParts)-part upload → s3://\(bucket)/\(key) (DEEP_ARCHIVE)")

// 5. Verify it's really there.
let head = try await client.headObject(input: HeadObjectInput(bucket: bucket, key: key))
print("🔎 HeadObject size=\(head.contentLength ?? -1) storageClass=\(head.storageClass?.rawValue ?? "STANDARD/default")")

UploadJournal.clear()
print("🧹 Journal cleared — done.")
