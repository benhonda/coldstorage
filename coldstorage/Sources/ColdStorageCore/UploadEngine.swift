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

/// A whole-run progress snapshot — enough for the UI to draw a bar, a byte readout, and (by differencing
/// snapshots over time) a throughput and ETA. Distinct from `UploadProgress`, which is one large file's own
/// determinate bar; this is the aggregate across every file and blob in the run, which is what a 1000-file
/// deposit needs (batched small files emit no per-file bar at all — that's the visibility gap this closes).
///
/// **Bytes are ENCRYPTED bytes.** Both `bytesUploaded` and `bytesTotal` count what actually crosses the wire,
/// so the bar reaches exactly 100% — the ~4-parts-per-million tag overhead vs the user's plaintext file sizes
/// is not worth a second unit. `bytesTotal` is derived at plan time from item sizes; for a Photos deposit
/// those are 0 until streamed, so `bytesTotal` can be 0 there — the UI falls back to file-count progress.
/// ETA is deliberately NOT here: it's a smoothed presentation value the UI computes from the snapshot stream.
public struct RunProgress: Sendable, Equatable {
    public let filesTotal: Int
    public let bytesTotal: Int
    public let filesArchived: Int
    public let bytesUploaded: Int
    /// The item currently streaming — the "now uploading …" line. `nil` before the first item / between runs.
    public let currentPath: String?
    public init(filesTotal: Int, bytesTotal: Int, filesArchived: Int, bytesUploaded: Int, currentPath: String?) {
        self.filesTotal = filesTotal; self.bytesTotal = bytesTotal
        self.filesArchived = filesArchived; self.bytesUploaded = bytesUploaded; self.currentPath = currentPath
    }
}

/// Accumulates run-wide progress and emits a fresh `RunProgress` on every change. An actor because the
/// updates arrive from two isolation domains — the engine (item start, file archived) and each blob's
/// `PartShipper` (bytes shipped) — so the tallies must be serialised, and the compiler proves it here rather
/// than us promising it.
actor RunProgressReporter {
    let filesTotal: Int
    let bytesTotal: Int
    private var filesArchived = 0
    private var bytesUploaded = 0
    private var currentPath: String?
    private let emit: @Sendable (RunProgress) async -> Void

    init(filesTotal: Int, bytesTotal: Int, emit: @escaping @Sendable (RunProgress) async -> Void) {
        self.filesTotal = filesTotal; self.bytesTotal = bytesTotal; self.emit = emit
    }

    private var snapshot: RunProgress {
        RunProgress(filesTotal: filesTotal, bytesTotal: bytesTotal,
                    filesArchived: filesArchived, bytesUploaded: bytesUploaded, currentPath: currentPath)
    }
    /// The opening 0-of-N tick, so the UI has a denominator the instant the run starts.
    func begin() async { await emit(snapshot) }
    func itemStarted(_ path: String) async { currentPath = path; await emit(snapshot) }
    func bytesShipped(_ n: Int) async { bytesUploaded += n; await emit(snapshot) }
    func fileArchived() async { filesArchived += 1; await emit(snapshot) }
}

/// The storage-quota ceiling a run must stay under, as the engine sees it: the account's `limitBytes`
/// (the free tier, or the plan's — pushed down from the app's entitlement) and the `usedBytes` already in
/// S3 at the moment the run starts (a live listing under the user's own prefix). The engine enforces this
/// at the blob boundary so a deposit — from the UI, a photo pick, OR the periodic auto-run — can't cross
/// the ceiling. `nil` (the `run` default) means DON'T enforce: dogfood mode, or an entitlement/usage the
/// app couldn't resolve — failing open there mirrors the app-side gate (never refuse over a missing number).
/// Bytes are ciphertext, matching `usedBytes` (S3 object sizes) and the plaintext quota within ~4 ppm.
public struct QuotaLimit: Sendable, Equatable {
    public let limitBytes: Int
    public let usedBytes: Int
    public init(limitBytes: Int, usedBytes: Int) { self.limitBytes = limitBytes; self.usedBytes = usedBytes }
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
                    prefix: VaultPrefix,
                    quota: QuotaLimit? = nil,
                    onFileArchived: (@Sendable (String, String) async -> Void)? = nil,
                    onProgress: (@Sendable (UploadProgress) async -> Void)? = nil,
                    onRunProgress: (@Sendable (RunProgress) async -> Void)? = nil) async throws -> [BlobFailure] {
        // RSS is logged at the three points that tell the hypotheses apart (see `ProcessMemory`): after the
        // SCAN (which hashes every byte), after each PART, and at the END. A climb in the first points at the
        // scan; a step per part that never comes back down points at per-request retention; flat at both says
        // the memory is going somewhere we haven't looked.
        let items = try await source.enumerate()
        log("UploadEngine: scanned \(items.count) item(s) — RSS \(ProcessMemory.resident)")
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
        // Run-wide progress. `bytesTotal` is what the plan will actually ship: each item is sealed into its own
        // frames (the carry resets per item), so the blob's ciphertext is the sum of its items' encrypted
        // sizes, and the run's is the sum over all items. Skipped blobs (`skipBlobIds` — permanently failed
        // last pass) are excluded so the bar's denominator is only work we'll attempt.
        let planned = plan.filter { !skipBlobIds.contains($0.id) }
        let reporter: RunProgressReporter? = onRunProgress.map { emit in
            let filesTotal = planned.reduce(0) { $0 + $1.items.count }
            let bytesTotal = planned.flatMap(\.items).reduce(0) { $0 + EnvelopeCipher.encryptedSize(ofPlaintext: $1.size) }
            return RunProgressReporter(filesTotal: filesTotal, bytesTotal: bytesTotal, emit: emit)
        }
        await reporter?.begin()
        // Storage-quota enforcement (see `QuotaLimit`). `used` tracks ciphertext bytes stored under this
        // user's prefix — seeded from the run-start S3 listing and grown by each blob we actually store.
        // A NEW blob that would cross the ceiling is REFUSED before a byte ships (`.overQuota`), and the run
        // continues past it (later blobs might be small enough to fit, and it retries once there's room).
        // Already-stored blobs (resume / relink no-ops) are never re-checked or re-counted — their bytes are
        // already in `used` via the listing. For a Photos deposit the plan-time size is 0 (the asset streams
        // its true size), so the crossing blob's real bytes only land in `used` AFTER it archives — bounding
        // any overshoot to that one blob, still authoritatively, which the client gate can't do at all.
        var used = quota?.usedBytes ?? 0
        for blob in planned {
            if let quota, !((try? journal.isBlobVerified(blob.id)) ?? false) {
                let incoming = blob.items.reduce(0) { $0 + EnvelopeCipher.encryptedSize(ofPlaintext: $1.size) }
                if used + incoming > quota.limitBytes {
                    let files = blob.items.map { BlobFailure.File(id: $0.id, path: $0.relativePath) }
                    log("UploadEngine: blob \(blob.id) REFUSED — over quota (used \(used) + \(incoming) > \(quota.limitBytes)) — \(files.count) file(s): \(files.map(\.path).joined(separator: ", "))")
                    failures.append(BlobFailure(blobId: blob.id, kind: .overQuota("Not enough storage left to back this up."), files: files))
                    continue
                }
            }
            do { used += try await archive(blob, onFileArchived: onFileArchived, onProgress: onProgress, reporter: reporter) }
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
        log("UploadEngine: run finished — RSS \(ProcessMemory.resident)")
        return failures
    }

    /// `onProgress` reports resumable-multipart progress as a determinate fraction of the *encrypted* blob —
    /// emitted once per uploaded 64 MiB part. **Solo-blob only:** a determinate bar is only meaningful for a
    /// large file (always its own blob); small files are batched into one blob and flip to `archived`
    /// near-instantly, so they keep the indeterminate bar. Bounded to one event per part per large file.
    /// Returns the ciphertext bytes it NEWLY stored — what the caller adds to the running quota total. Zero
    /// on a no-op (already verified + linked), a relink (bytes already on S3), or an all-empty blob.
    private func archive(_ blob: BlobPlan,
                         onFileArchived: (@Sendable (String, String) async -> Void)?,
                         onProgress: (@Sendable (UploadProgress) async -> Void)? = nil,
                         reporter: RunProgressReporter? = nil) async throws -> Int {
        // Idempotency is at the FILE level, not the blob level. A verified blob whose files are ALL linked is a
        // healthy no-op (the common case on every periodic re-scan) → return silently. But a verified blob with
        // any UNLINKED file is an orphan: a prior run died between `markBlobVerified` and the `markFileArchived`
        // loop, so the bytes are in S3 yet the tree shows nothing. Don't skip-and-strand — fall through and
        // re-encrypt (deterministic, so spans recompute identically) to re-link, while uploading nothing.
        let alreadyVerified = try journal.isBlobVerified(blob.id)
        if alreadyVerified {
            let orphaned = try blob.items.contains { try !journal.isFileArchived($0.id) }
            if !orphaned { return 0 }   // bytes in S3 and every file linked — nothing to do, no noise, no new bytes
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

        // Resume has to know which parts already landed BEFORE we stream: we must still *generate* their
        // ciphertext (it's what advances the frame counter and the byte offsets spans are measured in) but
        // must not re-send it. Only a blob that already has an open upload can have parts on S3.
        //
        // **Two sources of truth, and they can disagree.** `ListParts` says what S3 holds; the journal says
        // what we'll ASK S3 to assemble (`completedParts` feeds `complete`). A part can be on S3 yet missing
        // from the journal — `uploadPart` returns, then the process dies before the row commits, and there is
        // one such window per part. Skipping on S3's word alone would then drop that part from the complete
        // call, and `CompleteMultipartUpload` assembles ONLY the parts it is given: the object silently comes
        // back 64 MiB short, every later byte shifted, `verify` (a HEAD) none the wiser. So a part is skipped
        // only when BOTH agree it is done; otherwise we re-upload it, which S3 treats as an overwrite.
        let existingUploadId = alreadyVerified ? nil : try journal.uploadId(of: blob.id)
        let alreadyOnS3 = existingUploadId == nil ? []
            : try await store.existingParts(key: blob.s3Key, uploadId: existingUploadId!)
        let alreadyRecorded = Set(try journal.completedParts(blob.id).map(\.partNumber))

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
        let shipper = PartShipper(blob: blob, store: store, journal: journal,
                                  uploads: !alreadyVerified, existingUploadId: existingUploadId,
                                  alreadyOnS3: alreadyOnS3, alreadyRecorded: alreadyRecorded,
                                  solo: solo, encryptedTotal: encryptedTotal,
                                  onProgress: onProgress, reporter: reporter)

        // Any throw below (a drift-guard rejection, a part-upload failure surfacing through the backpressure
        // drain) abandons this blob — so cancel its still-running part uploads rather than leave them running
        // detached with their results dropped. Resume re-derives correctly from the journal either way.
        do {
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
            await reporter?.itemStarted(item.relativePath)   // the "now uploading …" line
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
            // afresh under a new id, which uploads cleanly. A `.opaque` content key (a Photos asset, whose
            // bytes don't exist until PhotoKit streams them) has no hash to check against, so it is exempt —
            // and the TYPE says so, rather than a comment hoping the next author notices.
            let sha = hasher.finalize().hex
            if let expected = item.content.verifiableSha256, expected != sha {
                throw ColdStorageError.contentDrift(
                    "\(item.relativePath) changed while it was being uploaded — it'll be picked up on the next pass")
            }

            log("UploadEngine: ✓ uploaded item [\(i + 1)/\(blob.items.count)] \(plaintextBytes) byte(s)")
            spans.append((item.id, start, offset - start, itemFirstFrame, sha, plaintextBytes))
        }
        try await shipper.finish()
        } catch {
            await shipper.cancelInFlight()
            throw error
        }

        // Complete → verify → mark verified. Skipped on the orphan-relink path: the parts are already on S3 and
        // the blob is already verified, so the pass above existed only to recompute spans for the re-link below.
        if !alreadyVerified {
            if let uid = await shipper.openUploadId {
                log("UploadEngine: blob \(blob.id) — \(offset) encrypted byte(s) in \(await shipper.partsEmitted) part(s); completing…")
                try await store.complete(key: blob.s3Key, uploadId: uid, parts: try journal.completedParts(blob.id))
                try await store.verify(key: blob.s3Key)
            } else {
                // EVERY item in this blob is zero bytes (a directory of `.gitkeep`s, say), so there is no
                // ciphertext and no object to put. S3 has no zero-byte multipart upload: `complete` with an
                // empty part list is rejected, and the code that rejects it is in `permanentS3Codes` — so this
                // blob used to fail PERMANENTLY, marking perfectly good (if empty) files as failed forever.
                // Nothing to upload is not a failure. The shipper never opened an upload (that's why there's no
                // id here), so nothing leaks either; the spans below record length 0, and `RestoreEngine`
                // short-circuits on a zero-length span rather than asking S3 for a backwards byte range.
                log("UploadEngine: blob \(blob.id) — no bytes (every item is empty); nothing to upload")
            }
            try journal.markBlobVerified(blob.id)
        }

        // Record file→blob mapping (archived = verified). ALWAYS runs — this is the step that links a file
        // into the tree, so running it on the orphan-repair path too is exactly what un-strands a dead deposit.
        for s in spans {
            try journal.markFileArchived(s.id, blobId: blob.id, offset: s.off, length: s.len, firstFrame: Int(s.firstFrame), plaintextSha256: s.sha, size: s.size)
            await onFileArchived?(s.id, blob.id)
            await reporter?.fileArchived()
        }
        log("UploadEngine: ✓ blob \(blob.id) — \(spans.count) file(s) \(alreadyVerified ? "re-linked" : "archived")")
        // NEW ciphertext stored this pass = `offset` for a fresh blob; a relink re-encrypted but uploaded
        // nothing (its bytes are already counted in the run's starting usage), so it adds nothing.
        return alreadyVerified ? 0 : offset
    }
}

/// Turns the blob's ciphertext stream into S3 multipart parts, uploading **up to `maxInFlight` parts
/// concurrently** while it keeps encrypting — so a link with headroom is actually filled, instead of one
/// part at a time with the pipe idle between round trips. Memory stays bounded by construction: at most
/// `maxInFlight` parts are in flight (each ≤ 64 MiB) plus the ~64 MiB buffer, never the blob and never disk.
///
/// **Why the parts can go up in parallel but the journal writes cannot.** S3 multipart parts are numbered and
/// independent, so their PUTs are order-free — that's the concurrency. But `complete` is assembled from the
/// journal (`completedParts`), and SQLite writes are not concurrency-safe, so each part's `recordPart` must be
/// serialised. The split: the **upload** runs in a detached `Task` off the actor (the parallel, slow, network
/// part); the **record** happens back on the actor when that task is drained (serial, fast). The compiler
/// enforces it — `journal` is only ever touched in actor-isolated context.
///
/// **Backpressure = the memory bound.** The producer (`archive`'s encrypt loop) awaits each `push` fully
/// before sealing the next frame, so it is strictly sequential; when `maxInFlight` parts are already
/// uploading, `flush` drains one before dispatching the next, which suspends `push` and therefore the
/// producer. Nothing accumulates.
/// Upload-concurrency tuning, in one place so the engine and its tests agree on it.
enum UploadTuning {
    /// Parts uploaded at once. 4 fills a typical link without a large memory footprint (~4 × 64 MiB in
    /// flight); override with `COLDSTORE_MAX_PARTS_INFLIGHT` (1 = the old strictly-sequential behaviour).
    static let maxPartsInFlight = max(1, ProcessInfo.processInfo.environment["COLDSTORE_MAX_PARTS_INFLIGHT"].flatMap(Int.init) ?? 4)
}

private actor PartShipper {
    let blob: BlobPlan
    let store: any BlobStore
    let journal: Journal
    /// `false` ⇒ generate the ciphertext but upload nothing (the orphan-relink pass, which exists only to
    /// recompute spans against a blob whose bytes are already on S3).
    let uploads: Bool
    /// Parts a previous, killed run already landed *and recorded*. We still have to GENERATE their bytes —
    /// that's what advances the frame counter and the byte offsets spans are measured in — but re-sending
    /// them would just burn the user's uplink re-uploading what S3 already holds. See `archive` for why BOTH
    /// sets have to agree before a part may be skipped.
    let alreadyOnS3: Set<Int>
    let alreadyRecorded: Set<Int>
    let solo: IngestItem?
    let encryptedTotal: Int
    let onProgress: (@Sendable (UploadProgress) async -> Void)?
    /// Run-wide progress: every part that becomes DONE reports its bytes here, so the aggregate bar advances
    /// for batched small-file blobs too — not just the solo `onProgress` case.
    let reporter: RunProgressReporter?

    private var buffer = Data()
    private(set) var partsEmitted = 0
    /// The multipart upload, opened **lazily on the first part that actually has bytes** — so a blob whose
    /// every item is empty never opens one at all. Eagerly opening it meant a zero-byte blob left a dangling
    /// multipart upload on S3 that no `complete` could ever close (see `archive`).
    private(set) var openUploadId: String?

    /// Parts whose PUT is running concurrently, keyed by part number; the byte count rides along so progress
    /// can be reported (and the bar advanced) when the part is drained.
    private var inFlight: [Int: (task: Task<(etag: String, sha: String), Error>, bytes: Int)] = [:]
    /// Cumulative encrypted bytes actually DONE — monotonic even though parts finish out of order, so the
    /// solo determinate bar never jumps backwards.
    private var shippedBytes = 0

    init(blob: BlobPlan, store: any BlobStore, journal: Journal,
         uploads: Bool, existingUploadId: String?, alreadyOnS3: Set<Int>, alreadyRecorded: Set<Int>,
         solo: IngestItem?, encryptedTotal: Int, onProgress: (@Sendable (UploadProgress) async -> Void)?,
         reporter: RunProgressReporter?) {
        self.blob = blob; self.store = store; self.journal = journal
        self.uploads = uploads; self.openUploadId = existingUploadId
        self.alreadyOnS3 = alreadyOnS3; self.alreadyRecorded = alreadyRecorded
        self.solo = solo; self.encryptedTotal = encryptedTotal; self.onProgress = onProgress
        self.reporter = reporter
    }

    /// Take one sealed frame and dispatch any whole part it just completed.
    func push(_ sealedFrame: Data) async throws {
        buffer.append(sealedFrame)
        try await flush(final: false)
    }

    /// End of blob: dispatch the remainder (S3's minimum part size doesn't apply to the last part), then wait
    /// for every in-flight upload to land — `complete` reads the journal, so all `recordPart`s must be done.
    func finish() async throws {
        try await flush(final: true)
        while !inFlight.isEmpty { try await drainOne() }
    }

    /// Cancel every still-running part upload and forget them. Called when `archive` abandons the blob — a
    /// drift-guard throw, a part failure surfacing through the backpressure drain, any error — so detached
    /// PUTs don't run on to completion with their results dropped. Safe to call more than once.
    func cancelInFlight() {
        for (_, part) in inFlight { part.task.cancel() }
        inFlight.removeAll()
    }

    /// Dispatch whole 64 MiB parts as they fill; on `final`, dispatch whatever is left. An empty blob emits
    /// nothing. Uploads run concurrently up to `maxInFlight`; this only blocks to enforce that bound.
    private func flush(final: Bool) async throws {
        while buffer.count >= S3Store.partSize || (final && !buffer.isEmpty) {
            let bytes = Data(buffer.prefix(min(buffer.count, S3Store.partSize)))
            buffer.removeFirst(bytes.count)
            partsEmitted += 1
            let number = partsEmitted

            // Relink pass (uploads=false): the bytes exist only to recompute spans and are already on S3 —
            // so nothing is dispatched, but they ARE done, and counting them keeps the aggregate bar honest
            // (bytesTotal includes this blob, so not counting it would leave the bar short for a relink pass).
            guard uploads else { await reportShipped(number: number, bytes: bytes.count); continue }

            // First real part → open the upload (resume reuses the one the journal already holds).
            if openUploadId == nil {
                let id = try await store.createUpload(key: blob.s3Key)
                try journal.setUploadId(blob.id, id)
                openUploadId = id
            }
            let uploadId = openUploadId!

            // Skip ONLY when S3 holds it *and* the journal knows about it — otherwise `complete`, which is fed
            // from the journal, would leave this part out and S3 would assemble a truncated object. A skipped
            // part is instantly done: count it toward progress, dispatch nothing.
            if alreadyOnS3.contains(number) && alreadyRecorded.contains(number) {
                await reportShipped(number: number, bytes: bytes.count)
                continue
            }

            // Bound the memory: never more than `maxInFlight` parts uploading at once. Draining suspends this
            // method — and therefore the strictly-sequential producer awaiting our `push` — so nothing piles up.
            while inFlight.count >= UploadTuning.maxPartsInFlight { try await drainOne() }

            let key = blob.s3Key   // capture the Sendable bits; the Task must not touch actor state synchronously
            let store = self.store
            let partBytes = bytes.count
            let task = Task { () throws -> (etag: String, sha: String) in
                // demo aid: slow parts so a kill/resume is easy to observe by hand
                if let ms = ProcessInfo.processInfo.environment["COLDSTORE_PART_DELAY_MS"].flatMap(Int.init), ms > 0 {
                    try await Task.sleep(for: .milliseconds(ms))
                }
                let r = try await store.uploadPart(key: key, uploadId: uploadId, number: number, data: bytes)
                // Announce the bytes the MOMENT S3 confirms this part — NOT when we later drain it for the journal.
                // Draining is lazy: a blob with ≤ maxPartsInFlight parts never drains until `finish`, so reporting
                // at drain time meant a whole small file uploaded in silence and then snapped to 100% at the end
                // (the "stuck on Preparing… until the file was basically done" bug). Report on real completion;
                // `drainOne` stays responsible only for the ordered journal write.
                await self.reportShipped(number: number, bytes: partBytes)
                return r
            }
            inFlight[number] = (task, bytes.count)
        }
    }

    /// Await the lowest-numbered in-flight upload, record it (serialised here on the actor), and count it
    /// toward progress. Order of draining doesn't matter to S3 — this just keeps it deterministic.
    private func drainOne() async throws {
        guard let number = inFlight.keys.min(), let part = inFlight.removeValue(forKey: number) else { return }
        let r = try await part.task.value
        // Progress was already reported by the task the instant its PUT confirmed — drain only performs the
        // ORDERED journal write (`complete` reads the journal, so records must land lowest-number-first).
        try journal.recordPart(PartRow(blobId: blob.id, partNumber: number,
                                       eTag: r.etag, sha256: r.sha, status: .uploaded))
    }

    /// A part is done (uploaded or already on S3): advance the aggregate bar and the solo determinate bar.
    private func reportShipped(number: Int, bytes: Int) async {
        shippedBytes += bytes
        if let solo, encryptedTotal > 0, let onProgress {
            await onProgress(UploadProgress(fileId: solo.id, path: solo.relativePath,
                                            uploaded: min(shippedBytes, encryptedTotal), total: encryptedTotal))
        }
        await reporter?.bytesShipped(bytes)
        log("UploadEngine: part \(number) shipped (\(bytes / 1_048_576) MiB) — RSS \(ProcessMemory.resident)")
    }
}
