import Foundation
import Crypto

/// Orchestrates: scan → plan → (per blob) stage-encrypt → resumable multipart → verify → journal.
/// V1 processes one blob at a time in newest-first order (correct + simple; cross-blob concurrency
/// is a tunable later). Resumability comes from deterministic encryption + the journal + ListParts.
public actor UploadEngine {
    let source: IngestSource
    let journal: Journal
    let store: S3Store
    let keys: KeyProvider
    let stagingDir: URL
    let cipher = EnvelopeCipher()

    public init(source: IngestSource, journal: Journal, store: S3Store, keys: KeyProvider, stagingDir: URL) {
        self.source = source; self.journal = journal; self.store = store
        self.keys = keys; self.stagingDir = stagingDir
        try? FileManager.default.createDirectory(at: stagingDir, withIntermediateDirectories: true)
    }

    public func run() async throws {
        let items = try await source.enumerate()
        try journal.upsert(items)
        for blob in BlobPlanner().plan(items) { try await archive(blob) }
    }

    private func archive(_ blob: BlobPlan) async throws {
        if try journal.isBlobVerified(blob.id) { return }   // already archived → idempotent skip
        let kek = try keys.userKEK()
        // Resume: if this blob exists, reuse its STORED key + nonce prefix so re-staging reproduces
        // byte-identical ciphertext (matching the parts already on S3). Only mint fresh for a new blob.
        let dek: SymmetricKey
        let prefix: Data
        if let stored = try journal.blobCrypto(blob.id) {
            prefix = stored.noncePrefix
            dek = try cipher.unwrap(stored.wrappedDEK, kek: kek)
        } else {
            dek = cipher.newDEK()
            prefix = cipher.randomPrefix()
            try journal.ensureBlob(blob, noncePrefix: prefix, wrappedDEK: try cipher.wrap(dek, kek: kek))
        }

        // 1. Stage: encrypt items into one local blob file (deterministic → re-stageable on resume).
        let staged = stagingDir.appendingPathComponent(blob.id)
        _ = FileManager.default.createFile(atPath: staged.path, contents: nil)
        let out = try FileHandle(forWritingTo: staged)
        var frame: UInt64 = 0, offset = 0
        var spans: [(id: String, off: Int, len: Int, firstFrame: UInt64, sha: String)] = []
        for item in blob.items {
            var hasher = SHA256(); let start = offset; let itemFirstFrame = frame; var carry = Data()
            func sealFrame(_ pt: Data) throws {
                let sealed = try cipher.seal(pt, dek: dek, prefix: prefix, frame: frame); frame += 1
                try out.write(contentsOf: sealed); offset += sealed.count
            }
            for try await chunk in item.open() {
                hasher.update(data: chunk); carry.append(chunk)
                while carry.count >= EnvelopeCipher.frameSize {
                    try sealFrame(Data(carry.prefix(EnvelopeCipher.frameSize))); carry.removeFirst(EnvelopeCipher.frameSize)
                }
            }
            if !carry.isEmpty { try sealFrame(carry) }
            spans.append((item.id, start, offset - start, itemFirstFrame, hasher.finalize().map { String(format: "%02x", $0) }.joined()))
        }
        try out.close()

        // 2. Upload, resume-aware.
        let uploadId: String
        if let existing = try journal.uploadId(of: blob.id) {
            uploadId = existing
        } else {
            let id = try await store.createUpload(key: blob.s3Key)
            try journal.setUploadId(blob.id, id)
            uploadId = id
        }
        let onS3 = try await store.existingParts(key: blob.s3Key, uploadId: uploadId)
        let fh = try FileHandle(forReadingFrom: staged); defer { try? fh.close() }
        let total = max((offset + S3Store.partSize - 1) / S3Store.partSize, 1)
        for n in 1...total where !onS3.contains(n) {
            try fh.seek(toOffset: UInt64((n - 1) * S3Store.partSize))
            guard let data = try fh.read(upToCount: S3Store.partSize), !data.isEmpty else { continue }
            let r = try await store.uploadPart(key: blob.s3Key, uploadId: uploadId, number: n, data: data)
            try journal.recordPart(PartRow(blobId: blob.id, partNumber: n, eTag: r.etag, sha256: r.sha, status: .uploaded))
            // demo aid: slow parts so kill/resume is easy to see against fast local MinIO
            if let ms = ProcessInfo.processInfo.environment["COLDSTORE_PART_DELAY_MS"].flatMap(Int.init), ms > 0 {
                try await Task.sleep(for: .milliseconds(ms))
            }
        }

        // 3. Complete + verify. 4. Record file→blob mapping (archived = verified).
        try await store.complete(key: blob.s3Key, uploadId: uploadId, parts: try journal.completedParts(blob.id))
        try await store.verify(key: blob.s3Key)
        try journal.markBlobVerified(blob.id)
        for s in spans { try journal.markFileArchived(s.id, blobId: blob.id, offset: s.off, length: s.len, firstFrame: Int(s.firstFrame), plaintextSha256: s.sha) }
        try? FileManager.default.removeItem(at: staged)
    }
}
