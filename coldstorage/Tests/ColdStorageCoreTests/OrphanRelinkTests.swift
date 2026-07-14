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
}
