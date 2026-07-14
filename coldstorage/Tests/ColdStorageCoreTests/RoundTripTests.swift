import Testing
import Foundation
@testable import ColdStorageCore

/// **Archive → restore, byte for byte.** The one test that asks the only question that finally matters: can
/// the user get their file back?
///
/// Nothing else was asking it. Every other test checks a step in isolation — the planner batches, the engine
/// marks blobs verified, `RestoreStep` decides. But the property the product actually sells lives in the
/// *seam* between the two engines: `archive` records where each file's bytes landed inside the blob (offset,
/// length, first frame number) and `restore` uses exactly those numbers to range-read, decrypt and verify. An
/// off-by-one in that arithmetic is invisible to both sides and fatal to the user, and it would surface only
/// when they tried to recover something — which is the worst possible moment for a backup tool to find a bug.
///
/// The `UploadEngine` rewrite (streaming straight into the multipart upload instead of via a staging file)
/// re-derived that arithmetic, which is precisely why this now exists.
@Suite struct RoundTripTests {

    /// An S3 that actually behaves like one: assembles the multipart parts into an object and serves ranged
    /// reads out of it. That's what makes this a real round-trip rather than two mocks agreeing with each other.
    final class InMemoryVault: Vault, @unchecked Sendable {
        private let lock = NSLock()
        private var parts: [String: [Int: Data]] = [:]
        private var objects: [String: Data] = [:]

        // BlobStore (the upload half)
        func createUpload(key: String) async throws -> String { "upload-\(key)" }
        func existingParts(key: String, uploadId: String) async throws -> Set<Int> { [] }
        func uploadPart(key: String, uploadId: String, number: Int, data: Data) async throws -> (etag: String, sha: String) {
            lock.withLock { parts[key, default: [:]][number] = data }
            return ("etag-\(number)", "sha-\(number)")
        }
        func complete(key: String, uploadId: String, parts completed: [PartRow]) async throws {
            lock.withLock {
                let byNumber = parts[key] ?? [:]
                objects[key] = byNumber.keys.sorted().reduce(Data()) { $0 + byNumber[$1]! }
            }
        }
        func verify(key: String) async throws {
            guard lock.withLock({ objects[key] != nil }) else { throw ColdStorageError.s3("no such object \(key)") }
        }

        // VaultStore (the restore half)
        func thawState(key: String) async throws -> ThawState { .ready }   // MinIO/Standard: always readable, no thaw
        func requestThaw(key: String, days: Int, tier: RestoreTier) async throws {}
        func getRange(key: String, offset: Int, length: Int) async throws -> Data {
            try lock.withLock {
                guard let object = objects[key] else { throw ColdStorageError.s3("no such object \(key)") }
                guard offset >= 0, offset + length <= object.count else {
                    throw ColdStorageError.s3("range \(offset)..<\(offset + length) outside object of \(object.count)")
                }
                return object.subdata(in: offset..<(offset + length))
            }
        }
        func usageBytes(prefix: VaultPrefix) async throws -> Int { lock.withLock { objects.values.reduce(0) { $0 + $1.count } } }
    }

    /// Archive a directory, then restore each file and compare against what went in.
    private func roundTrip(_ files: [String: Data]) async throws {
        let fm = FileManager.default
        let base = fm.temporaryDirectory.appendingPathComponent("cs-rt-\(UUID().uuidString)")
        let root = base.appendingPathComponent("data")
        let out = base.appendingPathComponent("out")
        try fm.createDirectory(at: root, withIntermediateDirectories: true)
        try fm.createDirectory(at: out, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: base) }
        for (name, bytes) in files { try bytes.write(to: root.appendingPathComponent(name)) }

        let journal = try Journal(path: base.appendingPathComponent("j.sqlite").path)
        let keys = LocalFileKEK(path: base.appendingPathComponent("kek.bin").path)
        let vault = InMemoryVault()

        let failures = try await UploadEngine(journal: journal, store: vault, keys: keys)
            .run(source: LocalDirSource(root: root))
        #expect(failures.isEmpty)

        let restore = RestoreEngine(journal: journal, store: vault, keys: keys, canSelfThaw: true)
        for (name, original) in files {
            let dest = out.appendingPathComponent(name)
            _ = try await restore.restore(fileId: name, to: dest)
            let recovered = try Data(contentsOf: dest)
            #expect(recovered == original, "\(name): restored \(recovered.count) bytes, archived \(original.count)")
        }
    }

    /// Several files BATCHED into one blob — so each one's bytes sit at a different offset inside the object,
    /// and restoring the third depends on the offset arithmetic being exactly right. This is the case a
    /// span/offset bug would break while a single-file test sailed through (its offset is always 0).
    @Test func batchedSmallFilesEachComeBackIntact() async throws {
        try await roundTrip([
            "a.bin": Data("the first file, which starts at offset zero".utf8),
            "b.bin": Data(repeating: 0x42, count: 300_000),   // pushes c.bin well past the first frame
            "c.bin": Data("the last file — it only decrypts if b's length was recorded right".utf8),
        ])
    }

    /// A file that spans MULTIPLE 4 MiB frames and lands mid-frame — so restore has to decrypt a run of
    /// frames and slice the requested bytes out of the middle of them.
    @Test func aFileSpanningManyFramesComesBackIntact() async throws {
        var rng = SystemRandomNumberGenerator()
        var bytes = Data(count: 0)
        bytes.reserveCapacity(EnvelopeCipher.frameSize * 2 + 7777)
        for _ in 0..<(EnvelopeCipher.frameSize * 2 + 7777) { bytes.append(UInt8.random(in: 0...255, using: &rng)) }
        try await roundTrip(["multiframe.bin": bytes])
    }

    /// A genuine MULTI-PART upload (> 64 MiB of ciphertext), so the object the restore reads was assembled
    /// from parts the engine shipped separately. If the streaming part boundaries didn't line up with the
    /// frame stream, the file comes back corrupt — and only a test like this would ever say so.
    @Test func aMultiPartFileComesBackIntact() async throws {
        let bytes = Data(repeating: 0x5A, count: S3Store.partSize + (4 << 20))   // > one part
        try await roundTrip(["big.bin": bytes])
    }
}
