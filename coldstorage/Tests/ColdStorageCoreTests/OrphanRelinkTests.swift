import Testing
import Foundation
@testable import ColdStorageCore

/// Idempotency lives at the FILE level, not the blob level. A blob can be verified in S3 while its file rows
/// were never linked (a prior run died between `markBlobVerified` and the `markFileArchived` loop) — an ORPHAN:
/// the bytes are safe but the tree shows nothing. These prove the engine RE-LINKS such a blob on the next pass
/// WITHOUT re-uploading, and that a healthy verified blob is a silent no-op (no wasted re-upload).
@Suite struct OrphanRelinkTests {

    /// A single-file (single-blob) source under a fresh temp dir, plus a wired engine sharing one journal/keys.
    private func fixture() throws -> (engine: UploadEngine, journal: Journal, keys: LocalFileKEK, store: FakeVault, source: LocalDirSource, base: URL) {
        let fm = FileManager.default
        let base = fm.temporaryDirectory.appendingPathComponent("cs-orphan-\(UUID().uuidString)")
        let root = base.appendingPathComponent("data")
        try fm.createDirectory(at: root, withIntermediateDirectories: true)
        try Data("hello orphan world".utf8).write(to: root.appendingPathComponent("f.bin"))
        let journal = try Journal(path: base.appendingPathComponent("j.sqlite").path)
        let keys = LocalFileKEK(path: base.appendingPathComponent("kek.bin").path)
        let store = FakeVault()
        let engine = UploadEngine(journal: journal, store: store, keys: keys)
        return (engine, journal, keys, store, LocalDirSource(root: root), base)
    }

    @Test func verifiedButUnlinkedBlobReLinksWithoutReUpload() async throws {
        let f = try fixture()
        defer { try? FileManager.default.removeItem(at: f.base) }

        // Hand-build the ORPHAN state: files upserted (planned) + blob crypto stored + blob marked verified, but
        // the markFileArchived loop never ran — exactly a run that died between verify and link.
        let items = try await f.source.enumerate()
        try f.journal.upsert(items)
        let blob = BlobPlanner().plan(items, prefix: .dev)[0]
        let cipher = EnvelopeCipher()
        try f.journal.ensureBlob(blob, noncePrefix: cipher.randomPrefix(),
                                 wrappedDEK: try cipher.wrap(cipher.newDEK(), kek: f.keys.userKEK()))
        try f.journal.markBlobVerified(blob.id)
        #expect(try f.journal.isBlobVerified(blob.id) == true)
        #expect(try f.journal.isFileArchived(items[0].id) == false)   // orphan confirmed: verified blob, unlinked file

        // Re-run the real pipeline: it must RE-LINK the file WITHOUT re-uploading the already-verified blob.
        let failures = try await f.engine.run(source: f.source, prefix: .dev)
        #expect(failures.isEmpty)
        #expect(try f.journal.isFileArchived(items[0].id) == true)    // un-stranded
        #expect(f.store.createdKeys.isEmpty)                          // and never re-attempted the upload
    }

    @Test func healthyVerifiedBlobIsSilentNoOpOnReRun() async throws {
        let f = try fixture()
        defer { try? FileManager.default.removeItem(at: f.base) }

        let items = try await f.source.enumerate()
        _ = try await f.engine.run(source: f.source, prefix: .dev)                  // first pass archives end-to-end
        #expect(try f.journal.isFileArchived(items[0].id) == true)
        let createdAfterFirst = f.store.createdKeys.count
        #expect(createdAfterFirst == 1)                               // sanity: the first pass really did upload

        _ = try await f.engine.run(source: f.source, prefix: .dev)                  // second pass: fully linked → nothing to do
        #expect(f.store.createdKeys.count == createdAfterFirst)       // no re-upload
        #expect(try f.journal.isFileArchived(items[0].id) == true)
    }

    /// **A repair may not re-link a member whose CONTENT changed.** The repair pass uploads nothing — it
    /// re-encrypts only to recompute spans — so if the file was edited since it was sealed, those spans
    /// describe bytes that aren't in S3. Nothing downstream catches it: the drift guard compares against the
    /// file's own CURRENT hash (which matches — it hashed the new bytes), and `verify` is a HEAD. It surfaces
    /// at restore, as garbage, which for a backup product is the worst possible place to find out.
    ///
    /// Reachable from an ordinary edit: an archived file whose bytes change is re-planned by `upsert`, which
    /// leaves its old blob holding an unlinked member — an orphan by definition.
    @Test func aBlobIsNotRepairedFromMembersWhoseContentChanged() async throws {
        let f = try fixture()
        defer { try? FileManager.default.removeItem(at: f.base) }
        let file = f.base.appendingPathComponent("data/f.bin")

        _ = try await f.engine.run(source: f.source, prefix: .dev)
        let sealedBlob = try #require(try f.journal.listFiles().first?.blobId)

        // Edit it — much longer, so a span measured over the new bytes cannot describe the old object.
        try Data(String(repeating: "rewritten, and far longer than before. ", count: 40).utf8).write(to: file)
        _ = try await f.engine.run(source: f.source, prefix: .dev)

        let row = try #require(try f.journal.listFiles().first)
        #expect(row.status == .archived)
        #expect(row.blobId != sealedBlob,
                "the edited file was re-linked to the blob sealed from its OLD bytes — its recorded span points into ciphertext that never held it, and the corruption only shows up at restore")
        #expect(f.store.createdKeys.count == 2, "the new bytes were never uploaded")
    }
}
