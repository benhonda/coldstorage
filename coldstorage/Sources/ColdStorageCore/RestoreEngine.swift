import Foundation
import Crypto

/// The other half of correctness: get a file back, byte-identical. Locates the logical file's
/// ciphertext span via the journal, ranged-GETs it, decrypts the frames (re-deriving nonces from
/// the stored prefix + frame counter), reassembles, and verifies against the stored plaintext hash.
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
    @discardableResult
    public func restore(fileId: String, to outURL: URL,
                        tier: RestoreTier = .standard, days: Int = 7) async throws -> RestoreOutcome {
        guard let f = try journal.fileMapping(fileId) else { throw ColdStorageError.staging("no archived file '\(fileId)'") }
        // Read the STORED key (SSOT) rather than recomputing `"blobs/<blobId>"` — a multi-user object lives
        // under its owner's prefix (`blobs/<cognito-identity-id>/<blobId>`), so recomputing would miss it.
        guard let key = try journal.blobS3Key(f.blobId) else { throw ColdStorageError.staging("no S3 key for blob \(f.blobId)") }
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
            // paid-retrieval gate had to be the THAW and not the read.
            try await download(f, key: key, to: outURL, fileId: fileId)
            return .restored
        }
    }

    /// Ranged-GET the file's ciphertext span, decrypt frame-by-frame, reassemble, hash-verify, write.
    private func download(_ f: (blobId: String, offset: Int, length: Int, firstFrame: Int, plaintextSha256: String),
                          key: String, to outURL: URL, fileId: String) async throws {
        guard let bc = try journal.blobCrypto(f.blobId) else { throw ColdStorageError.staging("no key material for blob \(f.blobId)") }
        let dek = try cipher.unwrap(bc.wrappedDEK, kek: try keys.userKEK())

        let ct = try await store.getRange(key: key, offset: f.offset, length: f.length)
        let sealedFrame = EnvelopeCipher.frameSize + 16   // full frame = 4 MiB plaintext + 16-byte tag

        var plain = Data(); var frame = UInt64(f.firstFrame); var pos = 0
        while pos < ct.count {
            let n = min(sealedFrame, ct.count - pos)
            plain.append(try cipher.open(ct.subdata(in: pos ..< pos + n), dek: dek, prefix: bc.noncePrefix, frame: frame))
            pos += n; frame += 1
        }

        let sha = SHA256.hash(data: plain).map { String(format: "%02x", $0) }.joined()
        guard sha == f.plaintextSha256 else { throw ColdStorageError.integrity("restored '\(fileId)' failed hash check") }
        try plain.write(to: outURL)
    }
}
