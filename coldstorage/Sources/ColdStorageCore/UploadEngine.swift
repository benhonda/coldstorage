import Foundation
import Crypto

/// One determinate upload-progress tick for a solo-blob file: how many encrypted bytes are up out of the
/// blob's total. Named fields (not a positional tuple) so the `uploaded`/`total` pair — both `Int` — can't
/// be transposed at the call site, which would silently invert the percentage.
public struct UploadProgress: Sendable, Equatable {
    public let fileId: String
    public let path: String
    public let uploaded: Int
    public let total: Int
    public init(fileId: String, path: String, uploaded: Int, total: Int) {
        self.fileId = fileId; self.path = path; self.uploaded = uploaded; self.total = total
    }
}

/// Orchestrates: scan → plan → (per blob) stage-encrypt → resumable multipart → verify → journal.
/// V1 processes one blob at a time in newest-first order (correct + simple; cross-blob concurrency
/// is a tunable later). Resumability comes from deterministic encryption + the journal + ListParts.
public actor UploadEngine {
    let journal: Journal
    let store: any BlobStore
    let keys: KeyProvider
    let stagingDir: URL
    let cipher = EnvelopeCipher()

    public init(journal: Journal, store: any BlobStore, keys: KeyProvider, stagingDir: URL) {
        self.journal = journal; self.store = store
        self.keys = keys; self.stagingDir = stagingDir
        try? FileManager.default.createDirectory(at: stagingDir, withIntermediateDirectories: true)
    }

    /// Scan the given source, plan blobs, and archive each. `onFileArchived(fileId, blobId)` fires as
    /// each logical file becomes verified — the hook the daemon turns into live `fileArchived` events.
    /// The source is passed per-run (not stored) so the daemon can rebuild it from the live registry.
    ///
    /// **Per-blob fault isolation:** a blob that fails is classified and recorded, and the run *continues*
    /// to the next blob — one poison blob must not block the rest of the backup. The returned failures let
    /// the daemon surface them and skip the permanent ones next pass (`skipBlobIds`). Only *whole-run*
    /// faults (scan / journal upsert) still throw, since there's nothing left to archive.
    @discardableResult
    public func run(source: IngestSource,
                    skipBlobIds: Set<String> = [],
                    onFileArchived: (@Sendable (String, String) async -> Void)? = nil,
                    onProgress: (@Sendable (UploadProgress) async -> Void)? = nil) async throws -> [BlobFailure] {
        let items = try await source.enumerate()
        try journal.upsert(items)
        var failures: [BlobFailure] = []
        for blob in BlobPlanner().plan(items) where !skipBlobIds.contains(blob.id) {
            do { try await archive(blob, onFileArchived: onFileArchived, onProgress: onProgress) }
            catch {
                let files = blob.items.map { BlobFailure.File(id: $0.id, path: $0.relativePath) }
                failures.append(BlobFailure(blobId: blob.id, kind: FailureKind.classify(error), files: files))
                try? FileManager.default.removeItem(at: stagingDir.appendingPathComponent(blob.id))   // don't leak a half-staged file
            }
        }
        return failures
    }

    /// `onProgress` reports resumable-multipart progress as a determinate fraction of the *encrypted* blob —
    /// emitted once per uploaded 64 MiB part. **Solo-blob only:** a determinate bar is only meaningful for a
    /// large file (always its own blob); small files are batched into one blob and flip to `archived`
    /// near-instantly, so they keep the indeterminate bar. Bounded to one event per part per large file.
    private func archive(_ blob: BlobPlan,
                         onFileArchived: (@Sendable (String, String) async -> Void)?,
                         onProgress: (@Sendable (UploadProgress) async -> Void)? = nil) async throws {
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
            // Determinate progress for a solo (large-file) blob: bytes uploaded so far over encrypted total.
            if blob.items.count == 1, let onProgress {
                let f = blob.items[0]
                await onProgress(UploadProgress(fileId: f.id, path: f.relativePath,
                                                uploaded: min(n * S3Store.partSize, offset), total: offset))
            }
            // demo aid: slow parts so kill/resume is easy to see against fast local MinIO
            if let ms = ProcessInfo.processInfo.environment["COLDSTORE_PART_DELAY_MS"].flatMap(Int.init), ms > 0 {
                try await Task.sleep(for: .milliseconds(ms))
            }
        }

        // 3. Complete + verify. 4. Record file→blob mapping (archived = verified).
        try await store.complete(key: blob.s3Key, uploadId: uploadId, parts: try journal.completedParts(blob.id))
        try await store.verify(key: blob.s3Key)
        try journal.markBlobVerified(blob.id)
        for s in spans {
            try journal.markFileArchived(s.id, blobId: blob.id, offset: s.off, length: s.len, firstFrame: Int(s.firstFrame), plaintextSha256: s.sha)
            await onFileArchived?(s.id, blob.id)
        }
        try? FileManager.default.removeItem(at: staged)
    }
}
