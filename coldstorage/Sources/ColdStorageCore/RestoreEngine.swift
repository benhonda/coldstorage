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
    let store: S3Store
    let keys: KeyProvider
    let cipher = EnvelopeCipher()

    public init(journal: Journal, store: S3Store, keys: KeyProvider) {
        self.journal = journal; self.store = store; self.keys = keys
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
        switch try await store.thawState(key: key) {
        case .needed:
            try await store.requestThaw(key: key, days: days, tier: tier)
            return .thawRequested(tier: tier)
        case .inProgress:
            return .thawInProgress
        case .ready:
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
