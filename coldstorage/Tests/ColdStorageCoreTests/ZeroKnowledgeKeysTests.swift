import Testing
import Foundation
import Crypto   // SymmetricKey — the Phase 5b SwappableKeyProvider tests seed/compare raw keys
@testable import ColdStorageCore

/// PROD.md Phase 3 gate: password change re-wraps MK without touching DEKs; recovery code unlocks;
/// round-trip still byte-identical; wrong password fails closed. Fast Argon2id tuning (still a real KDF
/// call, just the lightest libsodium preset) so the suite stays quick — production uses
/// `ZeroKnowledgeKeys.defaultOpsLimit`/`defaultMemLimit`.
@Suite struct ZeroKnowledgeKeysTests {
    // libsodium's real floor for Argon2id is opslimit=1, memlimit=8192 bytes (crypto_pwhash_argon2id_OPSLIMIT_MIN/
    // MEMLIMIT_MIN) — nowhere near "Interactive" (64 MiB). These still exercise the real KDF, just fast.
    private let fastOps = 1
    private let fastMem = 64 * 1024   // 64 KiB

    private func mint(password: String = "correct horse battery staple", recovery: String = "RECOVERY-CODE-1234") throws -> KeyBlob {
        try ZeroKnowledgeKeys.mint(password: password, recoveryCode: recovery, opsLimit: fastOps, memLimit: fastMem)
    }

    /// The lightweight tests above all override tuning for speed — this is the one that actually exercises
    /// `defaultOpsLimit`/`defaultMemLimit` (libsodium's "Moderate" preset, ~256 MiB), so a real memory/CPU
    /// constraint in the run environment would surface here instead of only ever in production.
    @Test func productionTuningActuallyDerivesAKey() throws {
        let blob = try ZeroKnowledgeKeys.mint(password: "correct horse battery staple", recoveryCode: "RECOVERY-CODE-1234")
        #expect(blob.opsLimit == ZeroKnowledgeKeys.defaultOpsLimit)
        #expect(blob.memLimit == ZeroKnowledgeKeys.defaultMemLimit)
        _ = try ZeroKnowledgeKeys.unlock(blob, password: "correct horse battery staple")
    }

    @Test func passwordAndRecoveryPathsUnlockToTheSameMasterKey() throws {
        let blob = try mint()
        let mkViaPassword = try ZeroKnowledgeKeys.unlock(blob, password: "correct horse battery staple")
        let mkViaRecovery = try ZeroKnowledgeKeys.unlockWithRecoveryCode(blob, recoveryCode: "RECOVERY-CODE-1234")
        #expect(mkViaPassword.withUnsafeBytes { Data($0) } == mkViaRecovery.withUnsafeBytes { Data($0) })
    }

    @Test func wrongPasswordFailsClosed() throws {
        let blob = try mint()
        #expect(throws: ZeroKnowledgeError.wrongSecret) {
            _ = try ZeroKnowledgeKeys.unlock(blob, password: "not the password")
        }
    }

    @Test func wrongRecoveryCodeFailsClosed() throws {
        let blob = try mint()
        #expect(throws: ZeroKnowledgeError.wrongSecret) {
            _ = try ZeroKnowledgeKeys.unlockWithRecoveryCode(blob, recoveryCode: "not the code")
        }
    }

    /// The load-bearing property of the whole hierarchy: changing the password must NOT touch any
    /// already-wrapped DEK, because DEKs are wrapped under MK (which never changes), not under a
    /// password-derived key directly. Proven by wrapping a real DEK under the MK *before* the password
    /// change, then unwrapping it with the MK recovered *after* — same bytes, no re-encryption needed.
    @Test func passwordChangeRewrapsMKWithoutTouchingDEKs() throws {
        let blob = try mint()
        let mkBefore = try ZeroKnowledgeKeys.unlock(blob, password: "correct horse battery staple")
        let cipher = EnvelopeCipher()
        let dek = cipher.newDEK()
        let wrappedDEK = try cipher.wrap(dek, kek: mkBefore)   // a real per-blob DEK, wrapped under MK — journal.wrappedDEK

        let rotated = try ZeroKnowledgeKeys.rewrapPassword(blob, oldPassword: "correct horse battery staple",
                                                           newPassword: "a whole new passphrase",
                                                           opsLimit: fastOps, memLimit: fastMem)

        // Recovery-path wrapping is untouched by a password-only change.
        #expect(rotated.wrappedMKRecovery == blob.wrappedMKRecovery)
        #expect(rotated.saltRecovery == blob.saltRecovery)
        // Old password no longer works; new one does, and unwraps to the SAME MK (so wrappedDEK still opens).
        #expect(throws: ZeroKnowledgeError.wrongSecret) {
            _ = try ZeroKnowledgeKeys.unlock(rotated, password: "correct horse battery staple")
        }
        let mkAfter = try ZeroKnowledgeKeys.unlock(rotated, password: "a whole new passphrase")
        #expect(mkAfter.withUnsafeBytes { Data($0) } == mkBefore.withUnsafeBytes { Data($0) })
        let recoveredDEK = try cipher.unwrap(wrappedDEK, kek: mkAfter)   // no DEK re-encryption happened — still opens
        #expect(recoveredDEK.withUnsafeBytes { Data($0) } == dek.withUnsafeBytes { Data($0) })
    }

    @Test func resetPasswordUsingRecoveryCodeKeepsTheSameMK() throws {
        let blob = try mint()
        let mkBefore = try ZeroKnowledgeKeys.unlockWithRecoveryCode(blob, recoveryCode: "RECOVERY-CODE-1234")
        let recovered = try ZeroKnowledgeKeys.resetPasswordUsingRecoveryCode(blob, recoveryCode: "RECOVERY-CODE-1234",
                                                                             newPassword: "brand new password",
                                                                             opsLimit: fastOps, memLimit: fastMem)
        let mkAfter = try ZeroKnowledgeKeys.unlock(recovered, password: "brand new password")
        #expect(mkAfter.withUnsafeBytes { Data($0) } == mkBefore.withUnsafeBytes { Data($0) })
    }

    /// `UserMasterKeyProvider` is a drop-in `KeyProvider` — construction IS the unlock (fails up front on
    /// a wrong secret), and it round-trips through the EXACT `EnvelopeCipher.wrap`/`unwrap` UploadEngine/
    /// RestoreEngine already use, unchanged, byte-identical.
    @Test func userMasterKeyProviderRoundTripsThroughTheRealEnvelopeCipher() throws {
        let blob = try mint()
        let provider = try UserMasterKeyProvider(unlocking: blob, password: "correct horse battery staple")
        let cipher = EnvelopeCipher()
        let dek = cipher.newDEK()
        let wrapped = try cipher.wrap(dek, kek: try provider.userKEK())
        let unwrapped = try cipher.unwrap(wrapped, kek: try provider.userKEK())
        #expect(unwrapped.withUnsafeBytes { Data($0) } == dek.withUnsafeBytes { Data($0) })

        #expect(throws: (any Error).self) {
            _ = try UserMasterKeyProvider(unlocking: blob, password: "wrong")
        }
        let viaRecovery = try UserMasterKeyProvider(unlockingWithRecoveryCode: blob, recoveryCode: "RECOVERY-CODE-1234")
        #expect(try viaRecovery.userKEK().withUnsafeBytes { Data($0) } == (try provider.userKEK().withUnsafeBytes { Data($0) }))
    }

    // MARK: - Phase 5b vault primitives (mintRecoveryOnly, recovery-code generator, SwappableKeyProvider)

    /// Passwordless signup: the recovery code alone recovers the SAME MK the mint loaded live — and the
    /// blob round-trips a real DEK through the exact EnvelopeCipher the engines use.
    @Test func mintRecoveryOnlyUnlocksToTheSameMKViaRecoveryCode() throws {
        let code = "AB3DE-FG4HJ-KM5NP-QR6ST-VW7XZ"
        let (blob, mk) = try ZeroKnowledgeKeys.mintRecoveryOnly(recoveryCode: code, opsLimit: fastOps, memLimit: fastMem)
        let mkViaRecovery = try ZeroKnowledgeKeys.unlockWithRecoveryCode(blob, recoveryCode: code)
        #expect(mkViaRecovery.withUnsafeBytes { Data($0) } == mk.withUnsafeBytes { Data($0) })

        // The password slot is a real (if permanently unreachable) wrap — the recovery code must NOT open it.
        #expect(throws: ZeroKnowledgeError.wrongSecret) {
            _ = try ZeroKnowledgeKeys.unlock(blob, password: code)
        }
    }

    @Test func generateRecoveryCodeIsWellFormedAndUnique() throws {
        let a = try ZeroKnowledgeKeys.generateRecoveryCode()
        let b = try ZeroKnowledgeKeys.generateRecoveryCode()
        #expect(a != b)
        // XXXXX-XXXXX-XXXXX-XXXXX-XXXXX over the Crockford alphabet (no I/L/O/U).
        #expect(a.count == 29)
        #expect(a.allSatisfy { "0123456789ABCDEFGHJKMNPQRSTVWXYZ-".contains($0) })
        #expect(a.split(separator: "-").count == 5)
    }

    /// The load-bearing 5b behavior: a multi-user daemon's key provider starts LOCKED (deposit/restore
    /// fail `.vaultLocked`), unlocks when the MK is loaded (round-trips a DEK), and re-locks on sign-out.
    @Test func swappableKeyProviderGatesOnUnlock() throws {
        let vault = SwappableKeyProvider()   // multi-user: starts locked
        #expect(vault.isUnlocked == false)
        #expect(throws: ZeroKnowledgeError.vaultLocked) { _ = try vault.userKEK() }

        let (_, mk) = try ZeroKnowledgeKeys.mintRecoveryOnly(recoveryCode: "AB3DE-FG4HJ-KM5NP-QR6ST-VW7XZ",
                                                             opsLimit: fastOps, memLimit: fastMem)
        vault.setMasterKey(mk)
        #expect(vault.isUnlocked)
        // A real DEK wrapped/unwrapped through the swapped-in key — proves the engines would encrypt under MK.
        let cipher = EnvelopeCipher()
        let dek = cipher.newDEK()
        let wrapped = try cipher.wrap(dek, kek: try vault.userKEK())
        #expect(try cipher.unwrap(wrapped, kek: try vault.userKEK()).withUnsafeBytes { Data($0) } == dek.withUnsafeBytes { Data($0) })

        vault.clear()   // sign-out
        #expect(vault.isUnlocked == false)
        #expect(throws: ZeroKnowledgeError.vaultLocked) { _ = try vault.userKEK() }
    }

    /// Dogfood mode: seeded at construction, unlocked immediately, never gates — behavior unchanged.
    @Test func swappableKeyProviderSeededIsUnlockedImmediately() throws {
        let seed = SymmetricKey(size: .bits256)
        let vault = SwappableKeyProvider(initial: seed)
        #expect(vault.isUnlocked)
        #expect(try vault.userKEK().withUnsafeBytes { Data($0) } == seed.withUnsafeBytes { Data($0) })
    }
}
