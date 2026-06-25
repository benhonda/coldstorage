import Testing
import Foundation
@testable import ColdStorageCore

/// `listFiles` is the browser's SSOT read — the journal IS the user's tree (paths/sizes/status), not S3.
/// These exercise the real SQLite path: upsert → archive → read back, ordering, and the blobId/status it
/// surfaces (which the UI coarsens into its own browse states).
@Suite struct JournalFilesTests {
    private func tempJournal() throws -> Journal {
        let path = FileManager.default.temporaryDirectory
            .appendingPathComponent("cs-files-\(ProcessInfo.processInfo.processIdentifier)-\(UUID().uuidString).sqlite").path
        return try Journal(path: path)
    }

    private func item(_ id: String, path: String, size: Int) -> IngestItem {
        IngestItem(id: id, relativePath: path, size: size, contentHash: "h-\(id)",
                   createdAt: nil, isFavorite: false,
                   open: { AsyncThrowingStream { $0.finish() } })
    }

    @Test func emptyJournalListsNothing() throws {
        #expect(try tempJournal().listFiles().isEmpty)
    }

    @Test func listsUpsertedFilesPathOrdered() throws {
        let j = try tempJournal()
        try j.upsert([
            item("b", path: "Photos/sunset.jpg", size: 30),
            item("a", path: "Documents/lease.pdf", size: 10),
        ])
        let rows = try j.listFiles()
        #expect(rows.map(\.relativePath) == ["Documents/lease.pdf", "Photos/sunset.jpg"])  // ORDER BY relativePath
        let lease = try #require(rows.first)
        #expect(lease.id == "a")
        #expect(lease.size == 10)
        #expect(lease.status == .planned)   // freshly upserted, not yet archived
        #expect(lease.blobId == nil)        // no blob until archived
    }

    @Test func archivedFileSurfacesBlobAndStatus() throws {
        let j = try tempJournal()
        try j.upsert([item("x", path: "a/b.jpg", size: 42)])
        try j.markFileArchived("x", blobId: "blob-1", offset: 0, length: 42, firstFrame: 0, plaintextSha256: "sha")
        let row = try #require(try j.listFiles().first)
        #expect(row.status == .archived)
        #expect(row.blobId == "blob-1")
    }

    /// A permanently-failed blob marks its files `failed` so the UI's ⚠ is journal truth, not a UI guess —
    /// it survives the next `listFiles` refresh (and a restart). Mirrors `DaemonService.performRun`.
    @Test func markFilesFailedPersistsFailedStatus() throws {
        let j = try tempJournal()
        try j.upsert([item("x", path: "a/b.jpg", size: 1), item("y", path: "a/c.jpg", size: 2)])
        try j.markFilesFailed(["x", "y"], error: "S3 AccessDenied")
        let rows = try j.listFiles()
        #expect(rows.allSatisfy { $0.status == .failed })
    }

    /// A later successful re-archive overwrites a prior `failed` back to `archived` (self-correcting after a
    /// transient-looking config fix on restart). And an empty id set is a no-op.
    @Test func reArchiveClearsFailedAndEmptyIsNoop() throws {
        let j = try tempJournal()
        try j.upsert([item("x", path: "a/b.jpg", size: 1)])
        try j.markFilesFailed([], error: "ignored")              // no-op, doesn't throw
        #expect(try #require(try j.listFiles().first).status == .planned)
        try j.markFilesFailed(["x"], error: "S3 AccessDenied")
        try j.markFileArchived("x", blobId: "blob-1", offset: 0, length: 1, firstFrame: 0, plaintextSha256: "sha")
        #expect(try #require(try j.listFiles().first).status == .archived)
    }
}
