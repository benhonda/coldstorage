import Foundation
import Crypto

/// The other half of correctness: get a file back, byte-identical. Locates the logical file's
/// ciphertext span via the journal, ranged-GETs it, decrypts the frames (re-deriving nonces from
/// the stored prefix + frame counter), reassembles, and verifies against the stored plaintext hash.
public struct RestoreEngine: Sendable {
    let journal: Journal
    let store: S3Store
    let keys: KeyProvider
    let cipher = EnvelopeCipher()

    public init(journal: Journal, store: S3Store, keys: KeyProvider) {
        self.journal = journal; self.store = store; self.keys = keys
    }

    public func restore(fileId: String, to outURL: URL) async throws {
        guard let f = try journal.fileMapping(fileId) else { throw ColdStorageError.staging("no archived file '\(fileId)'") }
        guard let bc = try journal.blobCrypto(f.blobId) else { throw ColdStorageError.staging("no key material for blob \(f.blobId)") }
        let dek = try cipher.unwrap(bc.wrappedDEK, kek: try keys.userKEK())

        let ct = try await store.getRange(key: "blobs/\(f.blobId)", offset: f.offset, length: f.length)
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
