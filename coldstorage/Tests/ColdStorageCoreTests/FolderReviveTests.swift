import Testing
import Foundation
@testable import ColdStorageCore

/// **Deleting a folder and re-uploading it.** The journal used to record deletion by overwriting
/// `files.status` with `deleted`, which destroyed the two other things that column encodes — the row's KIND
/// and its upload LIFECYCLE. Un-deleting therefore had nothing to restore to, so it wrote `discovered` over
/// the whole subtree by path prefix. Two user-visible bugs came out of that, and both are pinned here:
///
///   1. a folder MARKER came back as a phantom FILE named after the folder, so the folder appeared twice —
///      once real, once as a file stuck on "uploading" (`discovered` renders as uploading) for ever;
///   2. every file that had EVER been in that folder came back, dropped or not, with its blob link nulled —
///      permanently pending, and its bytes no longer reclaimable because the row counted as alive again.
///
/// Both are only reachable through the tombstone, so they're one suite. Deletion is a `deletedAt` timestamp
/// now, and a revive is scoped to the ids actually deposited.
@Suite struct FolderReviveTests {
    private func tempJournal() throws -> Journal {
        let path = FileManager.default.temporaryDirectory
            .appendingPathComponent("cs-revive-\(ProcessInfo.processInfo.processIdentifier)-\(UUID().uuidString).sqlite").path
        return try Journal(path: path)
    }

    private func item(_ path: String, hash: String? = nil) -> IngestItem {
        IngestItem(id: path, relativePath: path, size: 1, content: .sha256(hash ?? "h-\(path)"),
                   createdAt: nil, isFavorite: false,
                   open: { AsyncThrowingStream { $0.finish() } })
    }

    /// Pretend a blob archived these files, so revives have a real link to reason about.
    private func archive(_ j: Journal, _ paths: [String], blobId: String = "blob1") throws {
        try j.ensureBlob(BlobPlan(id: blobId, items: paths.map { item($0) }, prefix: .dev),
                         noncePrefix: Data(repeating: 0, count: 8), wrappedDEK: Data(repeating: 1, count: 8))
        try j.markBlobArchived(blobId, spans: paths.map {
            FileSpan(id: $0, offset: 0, length: 1, firstFrame: 0, plaintextSha256: "sha-\($0)", size: 1)
        })
    }

    // MARK: - bug 1: the folder marker came back as a file

    @Test func reDepositingADeletedFolderDoesNotLeaveAPhantomFileNamedAfterIt() throws {
        let j = try tempJournal()
        try j.createFolder(path: "Photos")            // UI "New folder" → a marker row
        try j.upsert([item("Photos/a.jpg")])
        try archive(j, ["Photos/a.jpg"])
        try j.deletePath("Photos")

        // The user drags the folder back in: the deposit enumerates the FILE, not the marker.
        try j.upsert([item("Photos/a.jpg")], reviving: true)

        let atFolderPath = try j.listFiles().filter { $0.relativePath == "Photos" }
        #expect(atFolderPath.allSatisfy { $0.status == .folder },
                "a folder marker came back as a file — the folder shows twice and the fake one never finishes uploading")
        #expect(try j.listFiles().count == 1)
    }

    /// A marker that IS explicitly restored must come back as a marker, not as a file.
    @Test func revivingAFolderMarkerKeepsItAMarker() throws {
        let j = try tempJournal()
        try j.createFolder(path: "Empty")
        let markerId = try #require(try j.listFiles().first?.id)
        try j.deletePath("Empty")
        try j.reviveFiles(ids: [markerId])
        #expect(try j.listFiles().map(\.status) == [.folder])
    }

    // MARK: - bug 2: files that weren't re-dropped came back stranded

    @Test func reDepositingAChangedFolderLeavesTheFilesYouDidNotDropDeleted() throws {
        let j = try tempJournal()
        try j.upsert([item("Photos/a.jpg"), item("Photos/b.jpg"), item("Photos/c.jpg")])
        try archive(j, ["Photos/a.jpg", "Photos/b.jpg", "Photos/c.jpg"])
        try j.deletePath("Photos")

        // The folder on disk has changed since the delete: b and c are gone, d is new.
        try j.upsert([item("Photos/a.jpg"), item("Photos/d.jpg")], reviving: true)

        #expect(try j.listFiles().map(\.relativePath) == ["Photos/a.jpg", "Photos/d.jpg"],
                "files that were never re-dropped came back — nothing on disk feeds them, so they can never finish uploading")
    }

    /// The stranded rows also broke reclamation: a revived row counts as alive, so its blob stopped being
    /// fully-deleted and its bytes could never be freed — while the row itself pointed at no blob at all.
    @Test func theFilesYouDidNotDropStayReclaimable() throws {
        let j = try tempJournal()
        try j.upsert([item("Photos/a.jpg"), item("Photos/b.jpg")])
        try archive(j, ["Photos/a.jpg", "Photos/b.jpg"], blobId: "blobAB")
        try j.deletePath("Photos")
        #expect(try j.fullyDeletedBlobIds() == ["blobAB"])

        // Re-drop only a.jpg, under a NEW blob (its old one is shared with the still-deleted b.jpg).
        try j.upsert([item("Photos/a.jpg")], reviving: true)
        #expect(try j.fullyDeletedBlobIds().isEmpty,
                "a blob with a live member was offered for reclamation")
        try j.deletePath("Photos/a.jpg")
        #expect(try j.fullyDeletedBlobIds() == ["blobAB"],
                "the blob never became reclaimable again — those bytes bill for ever with nothing pointing at them")
    }

    // MARK: - what a revive restores

    /// The bytes never left S3, so a revived file is `archived` — not miming an upload that isn't happening.
    @Test func revivingAFileWhoseBlobIsIntactKeepsItArchived() throws {
        let j = try tempJournal()
        try j.upsert([item("a.jpg")])
        try archive(j, ["a.jpg"])
        try j.deletePath("a.jpg")

        try j.upsert([item("a.jpg")], reviving: true)
        let row = try #require(try j.listFiles().first)
        #expect(row.status == .archived)
        #expect(row.blobId == "blob1", "a revived file lost its link to bytes that are still in S3")
        #expect(try j.settledFileIds().contains("a.jpg"), "an intact file was re-planned — that re-uploads what's already stored")
    }

    /// …but if its bytes were reclaimed, it must re-upload rather than point at an object on its way out.
    @Test func revivingAFileWhoseBlobWasReapedRePlansIt() throws {
        let j = try tempJournal()
        try j.upsert([item("a.jpg")])
        try archive(j, ["a.jpg"])
        try j.deletePath("a.jpg")
        try j.markBlobReaped("blob1")

        try j.upsert([item("a.jpg")], reviving: true)
        let row = try #require(try j.listFiles().first)
        #expect(row.status == .planned)
        #expect(row.blobId == nil)
        #expect(try j.settledFileIds().isEmpty, "a file whose bytes are gone was left settled — it would never be re-uploaded")
    }

    /// A file edited between the delete and the re-drop must re-upload, not silently keep the old bytes.
    @Test func revivingAFileWhoseContentChangedRePlansIt() throws {
        let j = try tempJournal()
        try j.upsert([item("a.jpg", hash: "old")])
        try archive(j, ["a.jpg"])
        try j.deletePath("a.jpg")

        try j.upsert([item("a.jpg", hash: "new")], reviving: true)
        #expect(try j.listFiles().first?.status == .planned,
                "a changed file was revived as archived — the vault would keep serving the bytes it had before")
    }

    /// The rule the revive exists to protect: a watched folder's re-scan must NEVER undo a delete.
    @Test func aRescanStillCannotReviveADeletedFile() throws {
        let j = try tempJournal()
        try j.upsert([item("a.jpg")])
        try archive(j, ["a.jpg"])
        try j.deletePath("a.jpg")

        try j.upsert([item("a.jpg")])   // the scanner can still see it on disk — not the user asking
        #expect(try j.listFiles().isEmpty)
    }
}
