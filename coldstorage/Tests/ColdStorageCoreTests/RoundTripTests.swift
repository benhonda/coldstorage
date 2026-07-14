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
        let vault = FakeVault()   // assembles the parts + serves ranged reads, so this is a REAL round trip

        let failures = try await UploadEngine(journal: journal, store: vault, keys: keys)
            .run(source: LocalDirSource(root: root), prefix: .dev)
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

    /// **A ZERO-BYTE file.** It has no ciphertext, so its span is `length: 0` — and a ranged read of zero
    /// bytes is the range `bytes=<offset>-<offset - 1>`, which is backwards and rejected by S3 (416). The file
    /// showed as archived and could never be recovered. Empty files are not exotic: `.gitkeep`, `__init__.py`,
    /// anything `touch`ed. Restoring one has to give back an empty file, not an error.
    @Test func aZeroByteFileComesBackAsAnEmptyFile() async throws {
        try await roundTrip([
            "empty.bin": Data(),
            "beside-it.bin": Data("a non-empty neighbour, batched into the same blob".utf8),
        ])
    }

    /// **A blob in which EVERY file is empty** — a directory of nothing but `.gitkeep`s. There are no bytes,
    /// so there are no parts; S3 has no zero-byte multipart upload, and `complete` with an empty part list is
    /// rejected with a code we classify as PERMANENT. The blob failed forever and marked those files `failed`.
    /// Nothing to upload is not a failure: the blob must succeed, having opened no upload at all.
    @Test func aBlobOfNothingButEmptyFilesSucceedsWithoutOpeningAnUpload() async throws {
        let fm = FileManager.default
        let base = fm.temporaryDirectory.appendingPathComponent("cs-rt-\(UUID().uuidString)")
        let root = base.appendingPathComponent("data")
        try fm.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: base) }
        try Data().write(to: root.appendingPathComponent(".gitkeep"))
        try Data().write(to: root.appendingPathComponent("also-empty"))

        let journal = try Journal(path: base.appendingPathComponent("j.sqlite").path)
        let vault = FakeVault()
        let failures = try await UploadEngine(journal: journal, store: vault,
                                              keys: LocalFileKEK(path: base.appendingPathComponent("kek.bin").path))
            .run(source: LocalDirSource(root: root), prefix: .dev)

        #expect(failures.isEmpty)                                  // …not a permanent failure
        #expect(try journal.isFileArchived(".gitkeep") == true)    // …and the files really are archived
        #expect(vault.createdKeys.isEmpty)                         // …having never opened a multipart upload to dangle
    }
}
