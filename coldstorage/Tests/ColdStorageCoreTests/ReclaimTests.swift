import Testing
import Foundation
@testable import ColdStorageCore

/// **Deleting has to mean something.**
///
/// Quota is measured from a live S3 listing, so bytes nothing references still consume the user's plan.
/// Without reclamation a delete frees nothing, ever: the vault fills with the ghosts of things the user
/// thought they'd removed, then refuses new deposits while showing a tree half its size.
///
/// Reclamation is a TAG, not a delete — the daemon holds the user's own credentials on their Mac, and
/// `s3:DeleteObject` there would let anything that compromises that machine erase the archive outright. A
/// bucket lifecycle rule does the expiry with credentials the client never sees.
///
/// Object granularity is the limit: a blob is one S3 object, so it's reclaimable only when EVERY file in it
/// is gone. That catches folder-shaped deletes (which is how people actually delete) and misses scattered
/// ones. The residue needs a repack, which Deep Archive makes uneconomic.
@Suite struct ReclaimTests {

    private func fixture() throws -> (engine: UploadEngine, journal: Journal, store: FakeVault, root: URL, base: URL) {
        let fm = FileManager.default
        let base = fm.temporaryDirectory.appendingPathComponent("cs-reclaim-\(UUID().uuidString)")
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

    @Test func deletingEveryFileInABlobReclaimsIt() async throws {
        let f = try fixture()
        defer { try? FileManager.default.removeItem(at: f.base) }

        try write("a.jpg", to: f.root); try write("b.jpg", to: f.root)
        _ = try await f.engine.run(source: LocalDirSource(root: f.root), prefix: .dev)
        let blobId = try #require(try f.journal.listFiles().first?.blobId)
        let key = try #require(try f.journal.blobS3Key(blobId))

        for row in try f.journal.listFiles() { try f.journal.deletePath(row.relativePath) }
        await f.engine.reapDeleted()

        #expect(f.store.reclaimableKeys.contains(key), "every file was deleted but the blob's bytes were never reclaimed — they keep consuming the user's quota forever")
        #expect(try f.journal.isBlobVerified(blobId) == false)   // moved to `reaped`
    }

    /// The conservative half, and the one that protects data: a blob with ANY live member holds bytes the
    /// user still expects to get back. Tagging it would expire those too.
    @Test func aBlobWithOneLiveFileIsNeverReclaimed() async throws {
        let f = try fixture()
        defer { try? FileManager.default.removeItem(at: f.base) }

        try write("gone.jpg", to: f.root); try write("kept.jpg", to: f.root)
        _ = try await f.engine.run(source: LocalDirSource(root: f.root), prefix: .dev)
        let blobId = try #require(try f.journal.listFiles().first?.blobId)
        // Sanity: these really do share one blob, or the test proves nothing.
        #expect(Set(try f.journal.listFiles().map(\.blobId)) == [blobId])

        try f.journal.deletePath("gone.jpg")
        await f.engine.reapDeleted()

        #expect(f.store.reclaimableKeys.isEmpty, "a blob still holding a live file was tagged for expiry — that destroys data the user never deleted")
        #expect(try f.journal.isBlobVerified(blobId) == true)
    }

    /// Reclaim runs on every pass, so it must not re-tag what it already handled — otherwise a vault with old
    /// deletions re-issues the same PutObjectTagging calls forever.
    @Test func aReclaimedBlobIsNotTaggedTwice() async throws {
        let f = try fixture()
        defer { try? FileManager.default.removeItem(at: f.base) }

        try write("a.jpg", to: f.root)
        _ = try await f.engine.run(source: LocalDirSource(root: f.root), prefix: .dev)
        for row in try f.journal.listFiles() { try f.journal.deletePath(row.relativePath) }

        await f.engine.reapDeleted()
        #expect(try f.journal.fullyDeletedBlobIds().isEmpty, "a reclaimed blob is still being offered for reclamation — the next pass will tag it again")
        await f.engine.reapDeleted()   // must be a clean no-op
        #expect(f.store.reclaimableKeys.count == 1)
    }

    /// Reaping is irreversible, so an incomplete journal must never authorise it. A member with no file row
    /// at all counts as ALIVE — we cannot prove those bytes are unwanted, so we keep them.
    @Test func aBlobWithAnUnknownMemberIsNeverReclaimed() async throws {
        let f = try fixture()
        defer { try? FileManager.default.removeItem(at: f.base) }

        try write("a.jpg", to: f.root)
        _ = try await f.engine.run(source: LocalDirSource(root: f.root), prefix: .dev)
        let blobId = try #require(try f.journal.listFiles().first?.blobId)
        for row in try f.journal.listFiles() { try f.journal.deletePath(row.relativePath) }

        // A member the journal has no file row for — a lost row, a partially restored journal, a bug. Built
        // through the real API: `ensureBlob` records membership, and its blob-row insert is a no-op on
        // conflict, so this adds a member to the existing blob without disturbing it.
        let ghost = IngestItem(id: "ghost-file-id", relativePath: "ghost.jpg", size: 1,
                               content: .sha256("ghost"), createdAt: nil, isFavorite: false,
                               open: { AsyncThrowingStream { $0.finish() } })
        try f.journal.ensureBlob(BlobPlan(id: blobId, items: [ghost], prefix: .dev),
                                 noncePrefix: Data(), wrappedDEK: Data())

        #expect(try f.journal.fullyDeletedBlobIds().isEmpty, "a blob with an unaccounted-for member was cleared for reclamation — that is a guess, and reaping is irreversible")
    }
}
