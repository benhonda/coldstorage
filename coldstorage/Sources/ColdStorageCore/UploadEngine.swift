import Foundation
import Crypto

/// Line to the daemon's stderr (→ `coldstored.err.log`, tailed by `task daemon:mac:logs`). The portable Core
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

/// Orchestrates: scan → plan → (per blob) stream-encrypt straight into a resumable multipart upload →
/// verify → journal. V1 processes one blob at a time in newest-first order (correct + simple; cross-blob
/// concurrency is a tunable later). Resumability comes from deterministic encryption + the journal + ListParts.
///
/// **The engine writes nothing to disk.** It used to encrypt each blob into a staging file and then upload
/// that file part by part, which cost a full second copy of every byte — so a 40 GB video demanded 40 GB of
/// free space, and a backup tool that needs as much headroom as the file it is saving fails exactly the user
/// who most needs it. The staging file bought nothing that justified it: resume never read those bytes back
/// (a resumed blob re-reads and re-encrypts from the source regardless — the journal's stored DEK and nonce
/// prefix make the ciphertext deterministic, so re-encrypting reproduces the parts already on S3 byte for
/// byte), it only postponed the first upload until the whole blob had been encrypted, and a killed run
/// stranded it on disk forever. Now the ciphertext flows source → frame → 64 MiB part → S3, and the only
/// thing held in memory is the part in flight.
public actor UploadEngine {
    let journal: Journal
    let store: any BlobStore
    let keys: KeyProvider
    let cipher = EnvelopeCipher()

    public init(journal: Journal, store: any BlobStore, keys: KeyProvider) {
        self.journal = journal; self.store = store; self.keys = keys
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
                    prefix: VaultPrefix = .dev,
                    onFileArchived: (@Sendable (String, String) async -> Void)? = nil,
                    onProgress: (@Sendable (UploadProgress) async -> Void)? = nil) async throws -> [BlobFailure] {
        let items = try await source.enumerate()
        try journal.upsert(items)
        var failures: [BlobFailure] = []
        // `prefix` lands every blob under the caller's own S3 namespace (`blobs/<cognito-identity-id>`) —
        // the per-user isolation the IAM role enforces. The journal records the resulting full `s3Key`,
        // which restore reads back (SSOT) — see RestoreEngine.
        let plan = BlobPlanner().plan(items, prefix: prefix)
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
                // so without this an upload failure is invisible in `task daemon:mac:logs`. Name the affected files.
                log("UploadEngine: blob \(blob.id) FAILED (\(kind.isPermanent ? "permanent" : "transient")): \(error) — \(files.count) file(s): \(files.map(\.path).joined(separator: ", "))")
                failures.append(BlobFailure(blobId: blob.id, kind: kind, files: files))
                // Nothing local to clean up — the engine writes no scratch. A failed blob leaves only its
                // open multipart upload on S3, which the bucket's 14-day abort lifecycle reaps (see DESIGN.md).
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
        // loop, so the bytes are in S3 yet the tree shows nothing. Don't skip-and-strand — fall through and
        // re-encrypt (deterministic, so spans recompute identically) to re-link, while uploading nothing.
        let alreadyVerified = try journal.isBlobVerified(blob.id)
        if alreadyVerified {
            let orphaned = try blob.items.contains { try !journal.isFileArchived($0.id) }
            if !orphaned { return }   // bytes in S3 and every file linked — nothing to do, no noise
            log("UploadEngine: blob \(blob.id) verified but has unlinked file(s) — recomputing spans to re-link (no re-upload)")
        }
        let kek = try keys.userKEK()
        // Resume: if this blob exists, reuse its STORED key + nonce prefix so re-encrypting reproduces
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

        // Open the multipart upload BEFORE streaming, because resume has to know which parts already landed:
        // we must still *generate* their ciphertext (it's what advances the frame counter and byte offsets the
        // spans are measured in) but must not re-send it. Skipped entirely on the orphan-relink path.
        var uploadId: String?
        var alreadyOnS3: Set<Int> = []
        if !alreadyVerified {
            if let existing = try journal.uploadId(of: blob.id) {
                uploadId = existing
            } else {
                let id = try await store.createUpload(key: blob.s3Key)
                try journal.setUploadId(blob.id, id)
                uploadId = id
            }
            alreadyOnS3 = try await store.existingParts(key: blob.s3Key, uploadId: uploadId!)
        }

        // The determinate progress bar needs a denominator, which staging used to supply by encrypting the
        // whole blob first and measuring it. It's derivable instead: framing is fixed and the nonce isn't
        // stored, so ciphertext = plaintext + one tag per frame. Solo blobs only — a batch of small files
        // flips to `archived` near-instantly and keeps the indeterminate bar. (A photo's `size` is 0 until
        // streamed, but a 0-size item never plans solo, so this is always a real file size.)
        let solo = blob.items.count == 1 ? blob.items[0] : nil
        let encryptedTotal = solo.map { EnvelopeCipher.encryptedSize(ofPlaintext: $0.size) } ?? 0

        var frame: UInt64 = 0
        var offset = 0        // encrypted bytes emitted so far — the coordinate system spans are recorded in
        var spans: [(id: String, off: Int, len: Int, firstFrame: UInt64, sha: String, size: Int)] = []
        // `uploadId: nil` IS the orphan-relink mode — generate the ciphertext to recompute spans, upload nothing.
        // Encoding that in the Optional rather than a parallel bool means the two can't disagree (PILLAR4).
        let shipper = PartShipper(blob: blob, store: store, journal: journal,
                                  uploadId: uploadId, alreadyOnS3: alreadyOnS3,
                                  solo: solo, encryptedTotal: encryptedTotal, onProgress: onProgress)

        // Stream: source → 4 MiB frames → the part buffer → S3. Items go SEQUENTIALLY into the one blob, so if
        // a stream stalls (an iCloud download, a PhotoKit callback that never fires) the per-item log pinpoints
        // WHICH item it parked on — a "→ uploading" with no matching "✓" is the culprit.
        for (i, item) in blob.items.enumerated() {
            var hasher = SHA256(); let start = offset; let itemFirstFrame = frame; var carry = Data()
            var plaintextBytes = 0   // exact plaintext size, measured as we stream (the SSOT the journal records)
            // Sync on purpose: an `async` local function capturing `frame`/`offset`/`dek` would carry mutable
            // locals across a suspension point, which Swift 6 rejects (rightly). Seal here, hand the bytes to
            // the actor there — the only thing that crosses an isolation boundary is a `Data`.
            func sealFrame(_ pt: Data) throws -> Data {
                let sealed = try cipher.seal(pt, dek: dek, prefix: prefix, frame: frame)
                frame += 1; offset += sealed.count
                return sealed
            }
            log("UploadEngine: → uploading item [\(i + 1)/\(blob.items.count)] \(item.relativePath)")
            for try await chunk in item.open() {
                hasher.update(data: chunk); carry.append(chunk); plaintextBytes += chunk.count
                while carry.count >= EnvelopeCipher.frameSize {
                    let sealed = try sealFrame(Data(carry.prefix(EnvelopeCipher.frameSize)))
                    carry.removeFirst(EnvelopeCipher.frameSize)
                    try await shipper.push(sealed)   // ships any part this frame completed — memory stays flat
                }
            }
            if !carry.isEmpty { try await shipper.push(try sealFrame(carry)) }

            // THE DRIFT GUARD. The bytes we just encrypted must be the bytes this blob was PLANNED from. If the
            // file changed under us, they aren't — and everything downstream would still look healthy: the
            // journal would record a SHA of whatever we happened to read, `verify` is only a HEAD, and the file
            // would be marked archived. The corruption would surface at RESTORE, which in a backup product is
            // the worst possible moment to discover it. Two real cases this catches:
            //   • the file was edited WHILE we read it → we uploaded a mix of old and new that never existed;
            //   • a resumed blob whose source changed since the scan → parts already on S3 hold the OLD bytes
            //     and the parts we just sent hold the NEW ones, so the object is torn.
            // Fail the blob instead. It's `permanent` and rightly so: this blob's id is derived from the old
            // content hash, so it can never be archived again — the next scan re-hashes the file and plans it
            // afresh under a new id, which uploads cleanly. `nil` = a source that cannot be hashed ahead of the
            // read (a Photos asset streams from iCloud), so there is nothing to check against.
            let sha = hasher.finalize().map { String(format: "%02x", $0) }.joined()
            if let expected = item.expectedSha256, expected != sha {
                throw ColdStorageError.contentDrift(
                    "\(item.relativePath) changed while it was being uploaded — it'll be picked up on the next pass")
            }

            log("UploadEngine: ✓ uploaded item [\(i + 1)/\(blob.items.count)] \(plaintextBytes) byte(s)")
            spans.append((item.id, start, offset - start, itemFirstFrame, sha, plaintextBytes))
        }
        try await shipper.finish()

        // Complete → verify → mark verified. Skipped on the orphan-relink path: the parts are already on S3 and
        // the blob is already verified, so the pass above existed only to recompute spans for the re-link below.
        if !alreadyVerified, let uid = uploadId {
            log("UploadEngine: blob \(blob.id) — \(offset) encrypted byte(s) in \(await shipper.partsEmitted) part(s); completing…")
            try await store.complete(key: blob.s3Key, uploadId: uid, parts: try journal.completedParts(blob.id))
            try await store.verify(key: blob.s3Key)
            try journal.markBlobVerified(blob.id)
        }

        // Record file→blob mapping (archived = verified). ALWAYS runs — this is the step that links a file
        // into the tree, so running it on the orphan-repair path too is exactly what un-strands a dead deposit.
        for s in spans {
            try journal.markFileArchived(s.id, blobId: blob.id, offset: s.off, length: s.len, firstFrame: Int(s.firstFrame), plaintextSha256: s.sha, size: s.size)
            await onFileArchived?(s.id, blob.id)
        }
        log("UploadEngine: ✓ blob \(blob.id) — \(spans.count) file(s) \(alreadyVerified ? "re-linked" : "archived")")
    }
}

/// Turns the blob's ciphertext stream into S3 multipart parts, holding **at most one part** in memory
/// (≤ 64 MiB + the frame being sealed) — never the blob, and never a copy on disk.
///
/// An `actor` rather than a nested function over `archive`'s locals, and not for style: the flush `await`s
/// S3, and mutable locals captured across a suspension point are precisely what Swift 6's concurrency
/// checking rejects. An actor lets the COMPILER prove the buffer is only ever touched serially, instead of us
/// promising it with `@unchecked Sendable` (PILLAR4 — let the type system carry the burden).
private actor PartShipper {
    let blob: BlobPlan
    let store: any BlobStore
    let journal: Journal
    /// `nil` ⇒ generate the ciphertext but upload nothing (the orphan-relink pass, which exists only to
    /// recompute spans against a blob whose bytes are already on S3).
    let uploadId: String?
    /// Parts a previous, killed run already landed. We still have to GENERATE their bytes — that's what
    /// advances the frame counter and the byte offsets spans are measured in — but re-sending them would
    /// just burn the user's uplink re-uploading what S3 already holds.
    let alreadyOnS3: Set<Int>
    let solo: IngestItem?
    let encryptedTotal: Int
    let onProgress: (@Sendable (UploadProgress) async -> Void)?

    private var buffer = Data()
    private(set) var partsEmitted = 0

    init(blob: BlobPlan, store: any BlobStore, journal: Journal, uploadId: String?, alreadyOnS3: Set<Int>,
         solo: IngestItem?, encryptedTotal: Int, onProgress: (@Sendable (UploadProgress) async -> Void)?) {
        self.blob = blob; self.store = store; self.journal = journal
        self.uploadId = uploadId; self.alreadyOnS3 = alreadyOnS3
        self.solo = solo; self.encryptedTotal = encryptedTotal; self.onProgress = onProgress
    }

    /// Take one sealed frame and ship out any whole part it just completed.
    func push(_ sealedFrame: Data) async throws {
        buffer.append(sealedFrame)
        try await flush(final: false)
    }

    /// End of blob: ship the remainder (S3's minimum part size doesn't apply to the last part).
    func finish() async throws { try await flush(final: true) }

    /// Ship whole 64 MiB parts as they fill; on `final`, ship whatever is left. An empty blob emits nothing.
    private func flush(final: Bool) async throws {
        while buffer.count >= S3Store.partSize || (final && !buffer.isEmpty) {
            let bytes = Data(buffer.prefix(min(buffer.count, S3Store.partSize)))
            buffer.removeFirst(bytes.count)
            partsEmitted += 1
            let number = partsEmitted

            guard let uploadId else { continue }   // relink pass: the bytes existed only to move the offsets

            if !alreadyOnS3.contains(number) {
                let r = try await store.uploadPart(key: blob.s3Key, uploadId: uploadId, number: number, data: bytes)
                try journal.recordPart(PartRow(blobId: blob.id, partNumber: number,
                                               eTag: r.etag, sha256: r.sha, status: .uploaded))
            }
            // Determinate progress for a solo (large-file) blob: encrypted bytes shipped over encrypted total.
            if let solo, encryptedTotal > 0, let onProgress {
                await onProgress(UploadProgress(fileId: solo.id, path: solo.relativePath,
                                                uploaded: min(number * S3Store.partSize, encryptedTotal),
                                                total: encryptedTotal))
            }
            // demo aid: slow parts so kill/resume is easy to see against fast local MinIO
            if let ms = ProcessInfo.processInfo.environment["COLDSTORE_PART_DELAY_MS"].flatMap(Int.init), ms > 0 {
                try await Task.sleep(for: .milliseconds(ms))
            }
        }
    }
}
