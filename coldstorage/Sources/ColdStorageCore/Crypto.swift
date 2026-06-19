import Foundation
import Crypto

/// V1 envelope crypto. Per-blob data key (DEK); AES-256-GCM frames with DETERMINISTIC counter
/// nonces, so a sealed blob is byte-reproducible — which is what makes encrypted multipart uploads
/// resumable (re-staging yields identical bytes → part ETags match). ZK later = stop escrowing the
/// KEK; format unchanged.
public struct EnvelopeCipher: Sendable {
    public static let frameSize = 4 << 20  // 4 MiB plaintext per frame
    public init() {}

    public func newDEK() -> SymmetricKey { SymmetricKey(size: .bits256) }
    public func randomPrefix() -> Data { Data((0..<4).map { _ in UInt8.random(in: 0...255) }) }

    /// 12-byte nonce = 4-byte per-blob prefix ++ 8-byte big-endian frame counter (unique within a blob).
    private func nonce(prefix: Data, frame: UInt64) throws -> AES.GCM.Nonce {
        var bytes = prefix
        withUnsafeBytes(of: frame.bigEndian) { bytes.append(contentsOf: $0) }
        return try AES.GCM.Nonce(data: bytes)
    }

    /// Seal one frame → ciphertext+tag. Nonce is reproducible from (prefix, frame), so not stored inline.
    public func seal(_ plaintext: Data, dek: SymmetricKey, prefix: Data, frame: UInt64) throws -> Data {
        let box = try AES.GCM.seal(plaintext, using: dek, nonce: try nonce(prefix: prefix, frame: frame))
        return box.ciphertext + box.tag
    }

    /// Reverse of `seal`: a sealed frame is ciphertext ++ 16-byte tag; nonce re-derived from (prefix, frame).
    public func open(_ sealedFrame: Data, dek: SymmetricKey, prefix: Data, frame: UInt64) throws -> Data {
        let split = sealedFrame.count - 16
        let box = try AES.GCM.SealedBox(nonce: try nonce(prefix: prefix, frame: frame),
                                        ciphertext: Data(sealedFrame.prefix(split)),
                                        tag: Data(sealedFrame.suffix(16)))
        return try AES.GCM.open(box, using: dek)
    }

    /// Wrap the DEK under the user KEK (server-escrowed in V1).
    public func wrap(_ dek: SymmetricKey, kek: SymmetricKey) throws -> Data {
        let raw = dek.withUnsafeBytes { Data($0) }
        guard let combined = try AES.GCM.seal(raw, using: kek).combined else {
            throw ColdStorageError.integrity("DEK wrap produced no output")
        }
        return combined
    }

    /// Unwrap a stored DEK — used on resume so re-staging reproduces identical ciphertext.
    public func unwrap(_ wrapped: Data, kek: SymmetricKey) throws -> SymmetricKey {
        let box = try AES.GCM.SealedBox(combined: wrapped)
        return SymmetricKey(data: try AES.GCM.open(box, using: kek))
    }
}

/// Source of the user's key-encrypting-key. V1 production = server escrow; ZK = user-held.
public protocol KeyProvider: Sendable { func userKEK() throws -> SymmetricKey }

/// Dev/local KEK persisted to a file — for container/CI runs only. NOT for production.
public struct LocalFileKEK: KeyProvider {
    let path: String
    public init(path: String) { self.path = path }
    public func userKEK() throws -> SymmetricKey {
        if let d = try? Data(contentsOf: URL(fileURLWithPath: path)) { return SymmetricKey(data: d) }
        let k = SymmetricKey(size: .bits256)
        try k.withUnsafeBytes { Data($0) }.write(to: URL(fileURLWithPath: path))
        return k
    }
}
