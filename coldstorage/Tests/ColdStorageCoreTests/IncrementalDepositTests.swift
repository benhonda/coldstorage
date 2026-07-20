import Testing
import Foundation
@testable import ColdStorageCore

/// **A deposit must cost what the deposit costs — not what the library costs.**
///
/// Blob ids are content-derived from their members, and `run` used to plan over the WHOLE scan. So a single
/// new file re-grouped the folder it landed in, minted fresh ids for blobs that were already verified, missed
/// the `isBlobVerified` short-circuit, and re-uploaded the lot. The old objects were left behind: nothing in
/// this codebase deletes from S3, they still count against the user's quota (`used` is seeded from an S3
/// listing), and Deep Archive bills them for a 180-day minimum regardless.
///
/// The bytes were never at risk — files only re-point after a successful verify — but the user paid for the
/// garbage in capacity, and once quota filled, further deposits were refused. These prove the engine now
/// plans only what isn't already stored.
@Suite struct IncrementalDepositTests {

    private func fixture() throws -> (engine: UploadEngine, journal: Journal, store: FakeVault, root: URL, base: URL) {
        let fm = FileManager.default
        let base = fm.temporaryDirectory.appendingPathComponent("cs-incr-\(UUID().uuidString)")
        let root = base.appendingPathComponent("data")
        try fm.createDirectory(at: root, withIntermediateDirectories: true)
        let journal = try Journal(path: base.appendingPathComponent("j.sqlite").path)
        let keys = LocalFileKEK(path: base.appendingPathComponent("kek.bin").path)
        let store = FakeVault()
        return (UploadEngine(journal: journal, store: store, keys: keys), journal, store, root, base)
    }

    private func write(_ name: String, to root: URL) throws {
        try Data("contents of \(name)".utf8).write(to: root.appendingPathComponent(name))
    }

    /// The headline guarantee: adding one file re-uploads one file's worth of bytes, and leaves every
    /// already-archived file pointing at the blob it was sealed into.
    @Test func addingOneFileDoesNotReUploadTheExistingLibrary() async throws {
        let f = try fixture()
        defer { try? FileManager.default.removeItem(at: f.base) }
        let source = LocalDirSource(root: f.root)

        for i in 0..<5 { try write("photo-\(i).jpg", to: f.root) }
        _ = try await f.engine.run(source: source, prefix: .dev)

        let before = try f.journal.listFiles().reduce(into: [String: String?]()) { $0[$1.id] = $1.blobId }
        let keysAfterFirst = f.store.createdKeys.count
        #expect(keysAfterFirst > 0)                       // sanity: the first pass really uploaded something

        // The deposit: one new file, newest — the case that used to sort to the front and shift every bucket.
        try write("photo-new.jpg", to: f.root)
        _ = try await f.engine.run(source: source, prefix: .dev)

        let after = try f.journal.listFiles().reduce(into: [String: String?]()) { $0[$1.id] = $1.blobId }
        let moved = before.filter { after[$0.key] != $0.value }
        #expect(moved.isEmpty, "\(moved.count) already-archived file(s) were re-planned into a different blob — that re-uploads stored bytes and orphans the old object")
        #expect(f.store.createdKeys.count == keysAfterFirst + 1, "the deposit should have created exactly one new blob")
    }

    /// Repeated deposits must not compound. Ten one-file deposits should cost ten blobs, not ten rewrites of
    /// everything that came before — this is the drip-feed shape (a screenshot habit, a camera auto-import)
    /// that made the old behaviour quietly expensive.
    @Test func repeatedDepositsDoNotCompound() async throws {
        let f = try fixture()
        defer { try? FileManager.default.removeItem(at: f.base) }
        let source = LocalDirSource(root: f.root)

        try write("drip-0.jpg", to: f.root)
        _ = try await f.engine.run(source: source, prefix: .dev)
        // The first file's home blob. Every later deposit must leave it exactly where it is — the assertion
        // that actually separates fixed from broken. A blob COUNT of 10 does not: these files all fit one
        // bucket, so the old behaviour also produced one new blob per pass (it just rewrote the previous
        // one each time and stranded it), and counting alone would call that a pass.
        let firstBlob = try #require(try f.journal.listFiles().first?.blobId)

        for i in 1..<10 {
            try write("drip-\(i).jpg", to: f.root)
            _ = try await f.engine.run(source: source, prefix: .dev)
        }

        let home = try f.journal.listFiles().first { $0.id.hasSuffix("drip-0.jpg") }?.blobId
        #expect(home == firstBlob, "the first file was rewritten into a new blob by later deposits — nine times over, orphaning its predecessor each time")
        #expect(f.store.createdKeys.count == 10)
        #expect(try f.journal.listFiles().filter { $0.status == .archived }.count == 10)
    }

    /// A file whose bytes are verified in S3 is archived, full stop — a *later* blob's failure says nothing
    /// about it. Without this guard, an over-quota refusal (or any permanent fault) that happened to include
    /// an already-stored file marked it ⚠ in the tree, telling the user a backup they already have didn't
    /// happen. Correct independent of any planner behaviour, which is why it's tested independently.
    @Test func anArchivedFileIsNeverMarkedFailed() async throws {
        let f = try fixture()
        defer { try? FileManager.default.removeItem(at: f.base) }

        try write("safe.jpg", to: f.root)
        _ = try await f.engine.run(source: LocalDirSource(root: f.root), prefix: .dev)
        let id = try #require(try f.journal.listFiles().first).id
        #expect(try f.journal.isFileArchived(id) == true)

        try f.journal.markFilesFailed([id], error: "Not enough storage left to back this up.")

        #expect(try f.journal.isFileArchived(id) == true, "an archived file was flipped to failed — the tree now claims a stored backup didn't happen")
        #expect(try f.journal.listFiles().first?.blobId != nil)   // and still resolves to its blob
    }
}
