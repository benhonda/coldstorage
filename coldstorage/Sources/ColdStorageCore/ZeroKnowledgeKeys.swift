import Foundation
import Crypto
import Sodium

/// PROD.md Phase 3 — the zero-knowledge key hierarchy. A random MasterKey (MK) IS the `userKEK()` the
/// existing wrap/unwrap code already expects, so `EnvelopeCipher`/`UploadEngine`/`RestoreEngine` and the
/// on-disk envelope format are UNCHANGED — only what *produces* the KEK changes. MK is protected by two
/// independent unlock paths, a password and a one-time recovery code, each an Argon2id-derived key
/// wrapping the SAME MK — so either secret alone recovers it, and a password change only ever re-wraps MK
/// (every blob's `wrappedDEK` is untouched, since DEKs are wrapped under MK, not under a password-derived
/// key directly). Server/AWS stores ONLY the ciphertexts + salts below (the "key-blob") — MK, the
/// password, and the recovery code never leave the device unencrypted.
public struct KeyBlob: Sendable, Equatable {
    /// MK, AES-256-GCM-wrapped (combined nonce+ciphertext+tag) under Argon2id(password, saltPassword).
    public var wrappedMKPassword: Data
    public var saltPassword: Data
    /// MK wrapped under Argon2id(recoveryCode, saltRecovery) — the same MK, a second independent lock.
    public var wrappedMKRecovery: Data
    public var saltRecovery: Data
    /// Argon2id tuning, stored alongside the salts: the raw KDF (unlike libsodium's self-describing
    /// `pwhash_str`) doesn't embed its params, so a future tuning bump can't silently strand old blobs.
    public var opsLimit: Int
    public var memLimit: Int

    public init(wrappedMKPassword: Data, saltPassword: Data, wrappedMKRecovery: Data, saltRecovery: Data,
                opsLimit: Int, memLimit: Int) {
        self.wrappedMKPassword = wrappedMKPassword
        self.saltPassword = saltPassword
        self.wrappedMKRecovery = wrappedMKRecovery
        self.saltRecovery = saltRecovery
        self.opsLimit = opsLimit
        self.memLimit = memLimit
    }
}

public enum ZeroKnowledgeError: Error, Equatable {
    /// A password/recovery code that fails to unwrap MK — AES-GCM's auth tag makes a wrong secret fail
    /// closed rather than silently returning garbage key material.
    case wrongSecret
    case saltGenerationFailed
    case derivationFailed
    /// The vault has no MasterKey loaded (multi-user daemon, before the app has sent the unlocked MK).
    /// Thrown by `SwappableKeyProvider.userKEK()` so a deposit/restore attempted before unlock fails
    /// clean — the crypto analogue of the identity pool refusing an unauthenticated S3 call.
    case vaultLocked
}

/// Argon2id-derive + AES-GCM wrap/unwrap of the MasterKey — the primitives `UserMasterKeyProvider` and
/// the signup/password-change/recovery flows are built from. Free-standing (not a `KeyProvider` itself)
/// because signup/rotation need to WRAP a blob, not just unlock one.
public enum ZeroKnowledgeKeys {
    /// Sane default tuning: not the lightest "Interactive" tier (this protects the whole vault's one
    /// MasterKey, and it runs once per unlock — never per-file, so cost here doesn't touch upload/restore
    /// throughput) but callers may override, e.g. for fast test runs.
    public static let defaultOpsLimit = Sodium().pwHash.OpsLimitModerate
    public static let defaultMemLimit = Sodium().pwHash.MemLimitModerate

    /// Signup: mint a random 256-bit MK and wrap it under both secrets. Returns the key-blob the server
    /// stores — ciphertexts + salts only; MK/password/recoveryCode never leave this call.
    public static func mint(password: String, recoveryCode: String,
                            opsLimit: Int = defaultOpsLimit, memLimit: Int = defaultMemLimit) throws -> KeyBlob {
        try mintReturningKey(password: password, recoveryCode: recoveryCode, opsLimit: opsLimit, memLimit: memLimit).blob
    }

    /// Passwordless signup (the decided 2026-07-02 model — recovery code is the ONLY human-held secret).
    /// The password slot is still filled (a wrap under a random, immediately-discarded secret) so the
    /// KeyBlob shape — and the account backend's not-null columns — stay intact while the slot is
    /// permanently unreachable; the recovery code is the sole real lock. Returns the blob to store AND
    /// the freshly-minted MK, since the caller (the daemon) both persists the blob and loads the key live.
    public static func mintRecoveryOnly(recoveryCode: String,
                                        opsLimit: Int = defaultOpsLimit, memLimit: Int = defaultMemLimit) throws -> (blob: KeyBlob, masterKey: SymmetricKey) {
        // A random throwaway "password" — never shown, stored, or recoverable. Keeps the password path a
        // valid (if unusable) wrap rather than junk bytes, so the KeyBlob stays internally consistent.
        let throwaway = try randomSalt().base64EncodedString()
        return try mintReturningKey(password: throwaway, recoveryCode: recoveryCode, opsLimit: opsLimit, memLimit: memLimit)
    }

    /// A cryptographically-random, transcription-safe recovery code: 25 chars of Crockford base32
    /// (no I/L/O/U), grouped `XXXXX-XXXXX-XXXXX-XXXXX-XXXXX`. `byte & 0x1F` is uniform over the 32-char
    /// alphabet (256 = 8×32), so this is a flat ~125 bits — enough to be the vault's sole lock.
    public static func generateRecoveryCode() throws -> String {
        let count = 25
        guard let bytes = Sodium().randomBytes.buf(length: count) else { throw ZeroKnowledgeError.saltGenerationFailed }
        let alphabet = Array("0123456789ABCDEFGHJKMNPQRSTVWXYZ")
        let chars = bytes.map { alphabet[Int($0 & 0x1F)] }
        return stride(from: 0, to: count, by: 5).map { String(chars[$0..<$0 + 5]) }.joined(separator: "-")
    }

    private static func mintReturningKey(password: String, recoveryCode: String,
                                         opsLimit: Int, memLimit: Int) throws -> (blob: KeyBlob, masterKey: SymmetricKey) {
        let mk = SymmetricKey(size: .bits256)
        let saltPassword = try randomSalt()
        let saltRecovery = try randomSalt()
        let cipher = EnvelopeCipher()
        let wrappedPassword = try cipher.wrap(mk, kek: try derive(secret: password, salt: saltPassword,
                                                                   opsLimit: opsLimit, memLimit: memLimit))
        let wrappedRecovery = try cipher.wrap(mk, kek: try derive(secret: recoveryCode, salt: saltRecovery,
                                                                   opsLimit: opsLimit, memLimit: memLimit))
        return (KeyBlob(wrappedMKPassword: wrappedPassword, saltPassword: saltPassword,
                        wrappedMKRecovery: wrappedRecovery, saltRecovery: saltRecovery,
                        opsLimit: opsLimit, memLimit: memLimit), mk)
    }

    /// Unwrap MK via the password path.
    public static func unlock(_ blob: KeyBlob, password: String) throws -> SymmetricKey {
        let kek = try derive(secret: password, salt: blob.saltPassword, opsLimit: blob.opsLimit, memLimit: blob.memLimit)
        return try unwrapOrWrongSecret(blob.wrappedMKPassword, kek: kek)
    }

    /// Unwrap MK via the recovery-code path — account access of last resort when the password is lost.
    public static func unlockWithRecoveryCode(_ blob: KeyBlob, recoveryCode: String) throws -> SymmetricKey {
        let kek = try derive(secret: recoveryCode, salt: blob.saltRecovery, opsLimit: blob.opsLimit, memLimit: blob.memLimit)
        return try unwrapOrWrongSecret(blob.wrappedMKRecovery, kek: kek)
    }

    /// Password change: re-wrap the SAME MK under a new password-derived KEK. Requires the CURRENT
    /// password; only `wrappedMKPassword`/`saltPassword` change — `wrappedMKRecovery` and every file's
    /// `wrappedDEK` are untouched, because MK itself never changes.
    public static func rewrapPassword(_ blob: KeyBlob, oldPassword: String, newPassword: String,
                                      opsLimit: Int = defaultOpsLimit, memLimit: Int = defaultMemLimit) throws -> KeyBlob {
        try rewrapPassword(blob, mk: try unlock(blob, password: oldPassword),
                           newPassword: newPassword, opsLimit: opsLimit, memLimit: memLimit)
    }

    /// Forgotten-password recovery: unlock MK via the recovery code, then set a fresh password. Same MK,
    /// so every DEK stays valid — only the password-path wrapping changes.
    public static func resetPasswordUsingRecoveryCode(_ blob: KeyBlob, recoveryCode: String, newPassword: String,
                                                      opsLimit: Int = defaultOpsLimit, memLimit: Int = defaultMemLimit) throws -> KeyBlob {
        try rewrapPassword(blob, mk: try unlockWithRecoveryCode(blob, recoveryCode: recoveryCode),
                           newPassword: newPassword, opsLimit: opsLimit, memLimit: memLimit)
    }

    private static func rewrapPassword(_ blob: KeyBlob, mk: SymmetricKey, newPassword: String,
                                       opsLimit: Int, memLimit: Int) throws -> KeyBlob {
        let saltPassword = try randomSalt()
        let wrappedPassword = try EnvelopeCipher().wrap(mk, kek: try derive(secret: newPassword, salt: saltPassword,
                                                                             opsLimit: opsLimit, memLimit: memLimit))
        var next = blob
        next.wrappedMKPassword = wrappedPassword
        next.saltPassword = saltPassword
        return next
    }

    private static func derive(secret: String, salt: Data, opsLimit: Int, memLimit: Int) throws -> SymmetricKey {
        guard let derived = Sodium().pwHash.hash(outputLength: 32, passwd: Bytes(secret.utf8), salt: Bytes(salt),
                                                 opsLimit: opsLimit, memLimit: memLimit, alg: .Argon2ID13) else {
            throw ZeroKnowledgeError.derivationFailed
        }
        return SymmetricKey(data: derived)
    }

    private static func unwrapOrWrongSecret(_ wrapped: Data, kek: SymmetricKey) throws -> SymmetricKey {
        do { return try EnvelopeCipher().unwrap(wrapped, kek: kek) }
        catch { throw ZeroKnowledgeError.wrongSecret }
    }

    private static func randomSalt() throws -> Data {
        guard let bytes = Sodium().randomBytes.buf(length: Sodium().pwHash.SaltBytes) else {
            throw ZeroKnowledgeError.saltGenerationFailed
        }
        return Data(bytes)
    }
}

/// The production `KeyProvider`: an already-unlocked MK, held for this session. Construction IS the
/// unlock — a wrong password/recovery code throws `.wrongSecret` up front rather than deferring the
/// failure to the first upload. Not yet wired into `coldstored/main.swift`: that needs somewhere to
/// fetch the `KeyBlob` from (the account backend, PROD.md Phase 4) and somewhere to capture the
/// password/recovery code (the sign-in UI, Phase 5) — premature before either exists.
public struct UserMasterKeyProvider: KeyProvider {
    // Raw bytes, not `SymmetricKey` — swift-crypto's `SymmetricKey` isn't `Sendable`, and `KeyProvider`
    // requires it. `Data` is Sendable; rebuilding the key from cached bytes on each `userKEK()` call is a
    // trivial wrap, not a re-derivation (Argon2id already ran once, in `init`).
    private let mkBytes: Data

    public init(unlocking blob: KeyBlob, password: String) throws {
        self.mkBytes = try ZeroKnowledgeKeys.unlock(blob, password: password).withUnsafeBytes { Data($0) }
    }

    public init(unlockingWithRecoveryCode blob: KeyBlob, recoveryCode: String) throws {
        self.mkBytes = try ZeroKnowledgeKeys.unlockWithRecoveryCode(blob, recoveryCode: recoveryCode).withUnsafeBytes { Data($0) }
    }

    public func userKEK() throws -> SymmetricKey { SymmetricKey(data: mkBytes) }
}
