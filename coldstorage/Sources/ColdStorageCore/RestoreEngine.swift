import Foundation
import Crypto

/// The other half of correctness: get a file back, byte-identical. Locates the logical file's
/// ciphertext span via the journal, streams the ranged GET, decrypts the frames as they arrive
/// (re-deriving nonces from the stored prefix + frame counter) straight to disk, and verifies the
/// incremental hash against the stored plaintext hash before the bytes may claim the destination.
///
/// Deep Archive can't be downloaded directly — it must be thawed (RestoreObject) first, which takes
/// hours. So `restore` is **idempotent and self-progressing**: call it, and it does the next right
/// step — request the thaw, report it's still thawing, or (once ready) download. Re-run until `.restored`.
public struct RestoreEngine: Sendable {
    let journal: Journal
    let store: any VaultStore
    let keys: KeyProvider
    let cipher = EnvelopeCipher()

    /// Whether THIS daemon is allowed to thaw Deep Archive objects itself.
    ///
    /// - **Dogfood / single-user (`true`)** — the daemon runs as the IAM user from
    ///   `infra/coldstorage/.../iam.tf`, which still holds `s3:RestoreObject`. It thaws directly, as it
    ///   always has.
    /// - **Multi-user (`false`)** — the daemon runs on a customer's Cognito credentials, and that role
    ///   deliberately has NO `s3:RestoreObject` (see `cognito.tf`). The thaw is the paid-retrieval hard
    ///   gate: only the account backend can perform it, and only for a restore that's paid for or inside
    ///   the free allowance (root `RETRIEVAL.md`).
    ///
    /// So this flag is not a preference — it mirrors what the daemon's credentials can actually DO.
    /// Attempting a thaw with `false` would just earn an AccessDenied; instead we return
    /// `.authorizationRequired` and let the app go get the restore authorized.
    let canSelfThaw: Bool

    public init(journal: Journal, store: any VaultStore, keys: KeyProvider, canSelfThaw: Bool = true) {
        self.journal = journal; self.store = store; self.keys = keys; self.canSelfThaw = canSelfThaw
    }

    /// Do the next step toward getting `fileId` back. Safe to re-run: starts the thaw if needed,
    /// reports progress while it's retrieving, and downloads + verifies once the copy is ready.
    ///
    /// `willDownload` fires at the ONE moment bytes are about to move — after the thaw is confirmed ready
    /// and before the ranged GET. It exists because the caller cannot infer that moment from the return
    /// value: `restore` returns `.restored` only once the download has already finished, so without this
    /// hook there is no way to tell "waiting ~48h for deep storage" apart from "actively transferring", and
    /// the app is forced to call the whole wait a download. That mislabel is precisely what
    /// {@link RestoreState} exists to fix, so the signal has to come from here, where the truth is known.
    ///
    /// `onProgress` then narrates the window `willDownload` opened: PLAINTEXT bytes decrypted and on disk so
    /// far, once per frame (~4 MiB). Plaintext, not ciphertext, because the denominator the caller shows
    /// beside it (`RestoreRow.bytes`) is the file's own size — the two must count the same thing or the bar
    /// finishes at 99.6%. Total is deliberately NOT passed back: the caller already owns it.
    @discardableResult
    public func restore(fileId: String, to outURL: URL,
                        tier: RestoreTier = .standard, days: Int = 7,
                        willDownload: (@Sendable () -> Void)? = nil,
                        onProgress: (@Sendable (_ plaintextBytes: Int) -> Void)? = nil) async throws -> RestoreOutcome {
        guard let f = try journal.fileMapping(fileId) else { throw ColdStorageError.invalidRequest("no archived file '\(fileId)'") }
        // Read the STORED key (SSOT) rather than recomputing `"blobs/<blobId>"` — a multi-user object lives
        // under its owner's prefix (`blobs/<cognito-identity-id>/<blobId>`), so recomputing would miss it.
        guard let key = try journal.blobS3Key(f.blobId) else { throw ColdStorageError.invalidRequest("no S3 key for blob \(f.blobId)") }
        // `thawState` is a HeadObject, which the daemon can always do — in BOTH modes. Only the thaw itself
        // (RestoreObject) is gated, so a multi-user daemon can still see exactly where a restore stands;
        // it just can't be the one to start it. The decision is pure + tested (`RestoreStep.next`).
        switch RestoreStep.next(thaw: try await store.thawState(key: key), canSelfThaw: canSelfThaw) {
        case .thaw:
            try await store.requestThaw(key: key, days: days, tier: tier)
            return .thawRequested(tier: tier)
        case .needsAuthorization:
            // Frozen, and we may not thaw it: the backend performs the thaw once this restore is paid for
            // (or covered by the free allowance). Hand back what the quote needs. A RETURN, not a throw —
            // this is the normal first step of a paid restore, not a failure.
            return .authorizationRequired(blobKey: key, egressBytes: f.length)
        case .wait:
            // A thaw is underway — started by us (dogfood) or by the backend (multi-user, once paid).
            // Nothing to do but re-run later.
            return .thawInProgress
        case .download:
            // Thawed, so a ranged GET works — the daemon keeps `s3:GetObject`, which is exactly why the
            // paid-retrieval gate had to be the THAW and not the read. Announce it FIRST: from here on
            // bytes really are moving, and this is the only instant at which that becomes true.
            willDownload?()
            try await download(f, key: key, to: outURL, fileId: fileId, onProgress: onProgress)
            return .restored
        }
    }

    /// Ranged-GET the file's ciphertext span as a CHUNK STREAM, decrypt frame-by-frame as it arrives,
    /// hash incrementally, and write each frame's plaintext straight to disk — then let the verified
    /// bytes claim the destination in one rename.
    ///
    /// **Memory holds one frame, never the file.** The first version of this read the whole span into one
    /// `Data` and accumulated the whole plaintext into another before writing — ~2× the file resident, which
    /// is invisible at photo sizes and kills the daemon at video sizes. The bound is now `pending` (at most
    /// one sealed frame + one network chunk, ~5 MiB) + the frame being decrypted; the memory test in
    /// `RestoreStreamingTests` pins that claim to a number, since no functional test can see the difference.
    ///
    /// **Streaming moves the write BEFORE the verify**, so bytes now touch disk before the hash is checked.
    /// That's why the sink is `<out>.coldstorage-partial`, not `outURL`: the destination path only ever holds
    /// bytes that passed verification, a failed download deletes the partial and leaves nothing, and a
    /// re-run starts clean by truncating it.
    private func download(_ f: (blobId: String, offset: Int, length: Int, firstFrame: Int, plaintextSha256: String),
                          key: String, to outURL: URL, fileId: String,
                          onProgress: (@Sendable (Int) -> Void)?) async throws {
        guard let bc = try journal.blobCrypto(f.blobId) else { throw ColdStorageError.invalidRequest("no key material for blob \(f.blobId)") }
        let dek = try cipher.unwrap(bc.wrappedDEK, kek: try keys.userKEK())

        // The destination's folders have to exist before anything can be written into them. This became
        // load-bearing when restoring a FOLDER started preserving its structure: `out` is no longer always
        // "<chosen folder>/<filename>" — it can be "<chosen folder>/2019/January/beach.jpg", and every one
        // of those intermediate folders is ours to create. Idempotent (`withIntermediateDirectories`), so
        // the flat case and a re-run both pass straight through.
        try FileManager.default.createDirectory(at: outURL.deletingLastPathComponent(),
                                                withIntermediateDirectories: true)

        // A ZERO-BYTE file has no ciphertext — no frames, no bytes, nothing to fetch. Ask S3 for it anyway
        // and you build the range `bytes=<offset>-<offset - 1>`, which is backwards and rejected (416): the
        // file would show as archived in the tree and be permanently unrecoverable. Its content is known
        // without a round trip, so short-circuit — but still check the recorded hash IS the hash of nothing,
        // so a corrupted journal row can't quietly hand back an empty file in place of real data.
        guard f.length > 0 else {
            let shaOfNothing = SHA256.hash(data: Data()).hex
            guard f.plaintextSha256 == shaOfNothing else {
                throw ColdStorageError.integrity("restored '\(fileId)' claims 0 bytes but its recorded hash isn't empty's")
            }
            try Data().write(to: outURL)
            try applyMetadata(fileId: fileId, to: outURL)
            return
        }

        let fm = FileManager.default
        let partial = outURL.appendingPathExtension("coldstorage-partial")
        // createFile truncates: a partial stranded by a killed daemon is never appended to, always replaced.
        guard fm.createFile(atPath: partial.path, contents: nil) else {
            throw ColdStorageError.invalidRequest("can't write to \(partial.path)")
        }
        let sink = try FileHandle(forWritingTo: partial)

        do {
            let sealedFrame = EnvelopeCipher.sealedFrameSize
            var hasher = SHA256()
            var frame = UInt64(f.firstFrame)
            var received = 0          // ciphertext bytes off the wire — checked against the span at EOF
            var written = 0           // plaintext bytes on disk — what onProgress reports
            var pending = Data()      // bounded: at most one sealed frame + one network chunk

            // Decrypt one sealed frame, hash it, land it, tick progress. Nested so the full-frame loop and
            // the final short frame share one spelling of the sequence — a drift between two copies of it
            // would be a silent corruption bug.
            //
            // `autoreleasepool` for the same reason as every `FileHandle` loop in this codebase (see
            // `Autorelease.swift` + `ChunkReader`): on macOS, Foundation file I/O returns autoreleased
            // buffers that a long-running async task never drains, and this loop runs for HOURS on a big
            // restore. A no-op on Linux — which is exactly why the Core's memory test cannot vouch for
            // its absence and it must be here by discipline, not by measurement.
            func openAndWrite(_ sealed: Data) throws {
                try autoreleasepool {
                    let plain = try cipher.open(sealed, dek: dek, prefix: bc.noncePrefix, frame: frame)
                    hasher.update(data: plain)
                    try sink.write(contentsOf: plain)
                    frame += 1
                    written += plain.count
                    onProgress?(written)
                }
            }

            for try await chunk in try await store.getRange(key: key, offset: f.offset, length: f.length) {
                received += chunk.count
                // More bytes than the span asked for means the range header was ignored or malformed —
                // decrypting on regardless would walk frames that aren't this file's.
                guard received <= f.length else {
                    throw ColdStorageError.s3("range read for '\(fileId)' returned \(received) of \(f.length) bytes asked")
                }
                pending.append(chunk)
                while pending.count >= sealedFrame {
                    try openAndWrite(Data(pending.prefix(sealedFrame)))
                    pending.removeFirst(sealedFrame)
                }
            }
            // A short read (connection cut, truncated object) previously surfaced as a baffling hash
            // mismatch — or, truncated exactly on a frame boundary, as an `.integrity` fault that would
            // condemn the transfer as corrupt. Name the actual fault with its own case: `.shortRead`
            // classifies TRANSIENT (the only ColdStorageError that does), so the next pass just retries.
            guard received == f.length else {
                throw ColdStorageError.shortRead("range read for '\(fileId)' ended early: \(received) of \(f.length) bytes")
            }
            if !pending.isEmpty { try openAndWrite(pending) }   // the final short frame

            try sink.close()
            guard hasher.finalize().hex == f.plaintextSha256 else {
                throw ColdStorageError.integrity("restored '\(fileId)' failed hash check")
            }
            // Only verified bytes may claim the destination — and in one move, so no reader ever sees a
            // half-written file at `outURL`. Remove-then-move rather than a platform atomic-replace API:
            // this is the portable Core, and the pre-streaming behavior (overwrite an existing file) holds.
            if fm.fileExists(atPath: outURL.path) { try fm.removeItem(at: outURL) }
            try fm.moveItem(at: partial, to: outURL)
            try applyMetadata(fileId: fileId, to: outURL)
        } catch {
            // Whatever failed — a dropped stream, a bad frame, the hash check — leave NOTHING behind:
            // no partial to confuse a Finder window, no unverified bytes at the destination.
            try? sink.close()
            try? fm.removeItem(at: partial)
            throw error
        }
    }

    /// Put the file's dates, permissions, flags and tags back (`FileMetadata.apply`). The bytes are already
    /// verified and in place; anything here that won't stick is logged, never a failed restore.
    private func applyMetadata(fileId: String, to outURL: URL) throws {
        guard let m = try journal.fileMetadata(fileId) else { return }
        for problem in m.apply(to: outURL) {
            log("RestoreEngine: '\(fileId)' restored, but couldn't put back \(problem)")
        }
    }
}
