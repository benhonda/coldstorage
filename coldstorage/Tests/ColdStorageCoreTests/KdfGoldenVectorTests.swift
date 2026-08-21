import Testing
import Foundation
import Crypto
@testable import ColdStorageCore

/// **The test that makes the libsodium dependency safe to change.**
///
/// `ZeroKnowledgeKeys` derives the key that wraps the MasterKey with Argon2id, via swift-sodium → libsodium.
/// Every other test in `ZeroKnowledgeKeysTests` derives and verifies inside the same run, so all of them
/// would still pass if the KDF started producing entirely different bytes — they'd just agree with each
/// other about the new wrong answer. Nothing pinned the output to a CONSTANT, which means nothing would
/// catch the one failure that matters: a dependency bump that changes what Argon2id returns locks every
/// existing user out of their vault permanently, and there is no recovery path — we hold no copy of the MK.
///
/// So: a golden vector. Fixed secret, fixed salt, fixed tuning, hard-coded expected output. Argon2id is a
/// specification, so this is stable across libsodium versions BY DEFINITION — which is exactly what makes it
/// a real check rather than a snapshot of an accident. If it ever fails, the dependency is wrong, not this
/// file, and it must not be "fixed" by pasting in the new value.
@Suite struct KdfGoldenVectorTests {
    /// Deliberately weak tuning — this is a correctness check on the primitive, not a cost check, and the
    /// production parameters take over a second each. The vector is no less binding for being cheap.
    private static let ops = 3
    private static let mem = 1 << 16   // 64 KiB

    @Test func argon2idOutputIsStableAcrossDependencyChanges() throws {
        let salt = Data(repeating: 0x42, count: 16)   // pwHash.SaltBytes is 16 for Argon2id13
        let key = try ZeroKnowledgeKeys.deriveForTest(secret: "correct horse battery staple",
                                                      salt: salt, opsLimit: Self.ops, memLimit: Self.mem)
        let hex = key.withUnsafeBytes { Data($0) }.map { String(format: "%02x", $0) }.joined()
        // Cross-checked against an INDEPENDENT Argon2id implementation (argon2-cffi over the reference C
        // library): Argon2id(t=3, m=64 KiB, p=1, len=32) of this secret+salt is byte-identical. So this
        // constant is the specification's answer, not a recording of whatever our stack happened to do —
        // which is the whole reason it can vouch for a dependency swap.
        #expect(hex == "2b1717e6d76877d9255e88e0d6735680855020ca75fa7ecc7da2537ec0b72e03",
                """
                Argon2id produced different bytes than it did when this vector was recorded. \
                Do NOT update the expected value — Argon2id is a spec, so a change here means the crypto \
                dependency is misbehaving, and shipping it would permanently lock every existing user out \
                of their vault (we hold no copy of the MasterKey).
                """)
    }

    /// A second, softer guard on the same dependency. These two constants come from libsodium, and they are
    /// what a NEW key blob is tuned with. Existing blobs carry their own `opsLimit`/`memLimit` (see
    /// `KeyBlob`), so a change here can't lock anyone out — but it silently re-prices every future unlock,
    /// and that should be a decision rather than a side effect of a version bump.
    @Test func moderateTuningIsWhatWeThinkItIs() {
        #expect(ZeroKnowledgeKeys.defaultOpsLimit == 3)
        #expect(ZeroKnowledgeKeys.defaultMemLimit == 268_435_456)   // 256 MiB
    }
}
