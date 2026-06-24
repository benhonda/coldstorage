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
}
