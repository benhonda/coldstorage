import Foundation
import Crypto

/// V1 envelope crypto. Per-blob data key (DEK); AES-256-GCM frames with DETERMINISTIC counter
/// nonces, so a sealed blob is byte-reproducible — which is what makes encrypted multipart uploads
/// resumable (re-staging yields identical bytes → part ETags match). ZK later = stop escrowing the
/// KEK; format unchanged.
public struct EnvelopeCipher: Sendable {
    public static let frameSize = 4 << 20  // 4 MiB plaintext per frame
    public static let tagSize = 16         // AES-GCM auth tag appended to every frame (the only expansion)
    /// One sealed frame on the wire. The SSOT for the size the RESTORE path walks the ciphertext in — upload
    /// and restore must agree on this byte-for-byte or a file decrypts to garbage, so they read it from here
    /// rather than each re-deriving `frameSize + 16`.
    public static let sealedFrameSize = frameSize + tagSize
    public init() {}

    /// Ciphertext size for a given plaintext size. The framing is fixed and the nonce isn't stored, so a
    /// sealed blob expands by exactly one tag per frame — meaning the encrypted total is KNOWABLE before we
    /// encrypt a single byte.
    ///
    /// That's what lets the engine stream straight into the multipart upload: it used to learn the total by
    /// encrypting the whole blob to a staging file first and measuring it, which is a poor reason to write
    /// every byte to disk twice. The determinate progress bar needs a denominator, not a file.
    public static func encryptedSize(ofPlaintext bytes: Int) -> Int {
        guard bytes > 0 else { return 0 }
        let frames = (bytes + frameSize - 1) / frameSize
        return bytes + frames * tagSize
    }

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
        let split = sealedFrame.count - Self.tagSize
        let box = try AES.GCM.SealedBox(nonce: try nonce(prefix: prefix, frame: frame),
                                        ciphertext: Data(sealedFrame.prefix(split)),
                                        tag: Data(sealedFrame.suffix(Self.tagSize)))
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

/// Lowercase hex — the on-the-wire form of every digest in the system. Hand-rolled in four places before
/// this, two of which (`UploadEngine`'s span hash and `RestoreEngine`'s verification hash) must produce
/// byte-identical output or every restore fails its integrity check. One spelling, one place (PILLAR3).
extension Sequence where Element == UInt8 {
    public var hex: String { map { String(format: "%02x", $0) }.joined() }
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

/// A `KeyProvider` whose key is swapped at RUNTIME — the seam that lets a multi-user daemon go from
/// LOCKED (no MasterKey yet) to unlocked once the app sends the MK over the control socket, and back on
/// sign-out, without rebuilding the upload/restore engines. Both engines are handed the SAME instance
/// (a reference type), so one swap is seen by upload and restore at once — exactly like `CognitoAuth`'s
/// resolver, which the `S3Client` holds by reference so `updateLogins` reaches every later call.
///
/// `@unchecked Sendable` guarded by a lock: `KeyProvider.userKEK()` is synchronous, so an `actor` (whose
/// methods are async) can't conform; the lock is held only around a `Data` read/write — never around
/// crypto — so there's no contention on the hot path.
public final class SwappableKeyProvider: KeyProvider, @unchecked Sendable {
    private let lock = NSLock()
    private var mkBytes: Data?

    /// `initial` present ⇒ dogfood mode: seed with the local-file KEK so behavior is byte-for-byte
    /// unchanged. `nil` ⇒ multi-user, LOCKED until an unlock/mint command lands — `userKEK()` throws
    /// `.vaultLocked`, so a deposit/restore attempted before unlock fails clean instead of encrypting
    /// under a wrong or absent key.
    public init(initial: SymmetricKey? = nil) {
        self.mkBytes = initial.map { $0.withUnsafeBytes { Data($0) } }
    }

    public func userKEK() throws -> SymmetricKey {
        lock.lock(); defer { lock.unlock() }
        guard let mkBytes else { throw ZeroKnowledgeError.vaultLocked }
        return SymmetricKey(data: mkBytes)
    }

    /// Load the unlocked MasterKey (from `mintVault`, an app-cached MK, or a recovery-code unlock).
    public func setMasterKey(_ key: SymmetricKey) {
        lock.lock(); defer { lock.unlock() }
        mkBytes = key.withUnsafeBytes { Data($0) }
    }

    /// Drop the key — sign-out. Subsequent `userKEK()` calls throw `.vaultLocked` again.
    public func clear() {
        lock.lock(); defer { lock.unlock() }
        mkBytes = nil
    }

    public var isUnlocked: Bool {
        lock.lock(); defer { lock.unlock() }
        return mkBytes != nil
    }
}
