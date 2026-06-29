import Foundation
import Crypto

/// Line to the daemon's stderr (→ `coldstored.err.log`, tailed by `task daemon:logs`). The portable Core
/// has no logger; upload faults are otherwise only emitted over the control socket, invisible at the daemon.
private func log(_ message: String) {
    FileHandle.standardError.write(Data("\(message)\n".utf8))
}

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
        let plan = BlobPlanner().plan(items)
        // Diagnostic: the batching shape (how N files map to M blobs) — a single failing blob sinks every file
        // batched into it, so the item-count per blob is exactly what explains an all-or-nothing deposit. Only
        // when there's work to plan, so an idle periodic re-scan stays silent instead of logging every interval.
        if !items.isEmpty {
            log("UploadEngine: \(items.count) item(s) → \(plan.count) blob(s) [\(plan.map { "\($0.items.count)" }.joined(separator: ","))]")
        }
        for blob in plan where !skipBlobIds.contains(blob.id) {
            do { try await archive(blob, onFileArchived: onFileArchived, onProgress: onProgress) }
            catch {
                let files = blob.items.map { BlobFailure.File(id: $0.id, path: $0.relativePath) }
                let kind = FailureKind.classify(error)
                // Surface the REAL cause to the daemon log — `blobFailed` only travels over the socket to the UI,
                // so without this an upload failure is invisible in `task daemon:logs`. Name the affected files.
                log("UploadEngine: blob \(blob.id) FAILED (\(kind.isPermanent ? "permanent" : "transient")): \(error) — \(files.count) file(s): \(files.map(\.path).joined(separator: ", "))")
                failures.append(BlobFailure(blobId: blob.id, kind: kind, files: files))
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
        // Idempotency is at the FILE level, not the blob level. A verified blob whose files are ALL linked is a
        // healthy no-op (the common case on every periodic re-scan) → return silently. But a verified blob with
        // any UNLINKED file is an orphan: a prior run died between `markBlobVerified` and the `markFileArchived`
        // loop, so the bytes are in S3 yet the tree shows nothing. Don't skip-and-strand — fall through to
        // re-stage (deterministic, so spans recompute identically) and re-link, while skipping the re-upload.
        let alreadyVerified = try journal.isBlobVerified(blob.id)
        if alreadyVerified {
            let orphaned = try blob.items.contains { try !journal.isFileArchived($0.id) }
            if !orphaned { return }   // bytes in S3 and every file linked — nothing to do, no noise
            log("UploadEngine: blob \(blob.id) verified but has unlinked file(s) — re-staging to re-link (no re-upload)")
        }
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
        var spans: [(id: String, off: Int, len: Int, firstFrame: UInt64, sha: String, size: Int)] = []
        // Diagnostic: per-item staging milestones. Items stream SEQUENTIALLY into the one blob, so if a stream
        // stalls (e.g. an iCloud download or a PhotoKit callback that never fires) this pinpoints WHICH item it
        // parks on — a "→ staging" with no matching "✓ staged" is the culprit.
        for (i, item) in blob.items.enumerated() {
            var hasher = SHA256(); let start = offset; let itemFirstFrame = frame; var carry = Data()
            var plaintextBytes = 0   // exact plaintext size, measured as we stream (the SSOT the journal records)
            func sealFrame(_ pt: Data) throws {
                let sealed = try cipher.seal(pt, dek: dek, prefix: prefix, frame: frame); frame += 1
                try out.write(contentsOf: sealed); offset += sealed.count
            }
            log("UploadEngine: → staging item [\(i + 1)/\(blob.items.count)] \(item.relativePath)")
            for try await chunk in item.open() {
                hasher.update(data: chunk); carry.append(chunk); plaintextBytes += chunk.count
                while carry.count >= EnvelopeCipher.frameSize {
                    try sealFrame(Data(carry.prefix(EnvelopeCipher.frameSize))); carry.removeFirst(EnvelopeCipher.frameSize)
                }
            }
            if !carry.isEmpty { try sealFrame(carry) }
            log("UploadEngine: ✓ staged item [\(i + 1)/\(blob.items.count)] \(plaintextBytes) byte(s)")
            spans.append((item.id, start, offset - start, itemFirstFrame, hasher.finalize().map { String(format: "%02x", $0) }.joined(), plaintextBytes))
        }
        try out.close()

        // 2 + 3. Upload (resume-aware) → complete → verify → mark the blob verified. SKIPPED on the orphan-repair
        // path: the parts are already on S3 and the blob is already verified, so we only needed the re-stage above
        // to recompute spans for re-linking.
        if !alreadyVerified {
            log("UploadEngine: staged blob \(blob.id) — \(offset) encrypted byte(s); uploading…")
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
            try await store.complete(key: blob.s3Key, uploadId: uploadId, parts: try journal.completedParts(blob.id))
            try await store.verify(key: blob.s3Key)
            try journal.markBlobVerified(blob.id)
        }

        // 4. Record file→blob mapping (archived = verified). ALWAYS runs — this is the step that links a file
        // into the tree, so running it on the orphan-repair path too is exactly what un-strands a dead deposit.
        for s in spans {
            try journal.markFileArchived(s.id, blobId: blob.id, offset: s.off, length: s.len, firstFrame: Int(s.firstFrame), plaintextSha256: s.sha, size: s.size)
            await onFileArchived?(s.id, blob.id)
        }
        log("UploadEngine: ✓ blob \(blob.id) — \(spans.count) file(s) \(alreadyVerified ? "re-linked" : "archived")")
        try? FileManager.default.removeItem(at: staged)
    }
}
