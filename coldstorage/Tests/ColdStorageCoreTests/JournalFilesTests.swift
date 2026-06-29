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
        try j.markFileArchived("x", blobId: "blob-1", offset: 0, length: 58, firstFrame: 0, plaintextSha256: "sha", size: 42)
        let row = try #require(try j.listFiles().first)
        #expect(row.status == .archived)
        #expect(row.blobId == "blob-1")
    }

    /// The Photos case: a deposited asset is upserted size 0 (size is unknown until streamed), and
    /// `markFileArchived` MUST overwrite it with the real plaintext byte count measured during staging —
    /// otherwise the browser shows "0 B" for every photo. `length` is the larger ciphertext span and must
    /// NOT leak into `size`.
    @Test func archiveOverwritesUnknownSizeWithRealPlaintextBytes() throws {
        let j = try tempJournal()
        try j.upsert([item("p", path: "Photos/IMG_8111.HEIC", size: 0)])   // 0 = unknown at discovery
        #expect(try #require(try j.listFiles().first).size == 0)
        try j.markFileArchived("p", blobId: "b", offset: 0, length: 2_097_168, firstFrame: 0, plaintextSha256: "sha", size: 2_097_152)
        #expect(try #require(try j.listFiles().first).size == 2_097_152)    // real plaintext, not the 0 nor the ciphertext length
    }

    /// `createdAt` captured at upsert survives to `listFiles` (epoch seconds); a source with no date → nil.
    @Test func createdAtRoundTrips() throws {
        let j = try tempJournal()
        let when = Date(timeIntervalSince1970: 1_700_000_000)
        try j.upsert([
            IngestItem(id: "dated", relativePath: "a.jpg", size: 1, contentHash: "h1",
                       createdAt: when, isFavorite: false, open: { AsyncThrowingStream { $0.finish() } }),
            item("undated", path: "b.jpg", size: 1),   // helper passes createdAt: nil
        ])
        let rows = try j.listFiles()
        #expect(rows.first(where: { $0.id == "dated" })?.createdAt == 1_700_000_000)
        #expect(rows.first(where: { $0.id == "undated" })?.createdAt == nil)
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
        try j.markFileArchived("x", blobId: "blob-1", offset: 0, length: 1, firstFrame: 0, plaintextSha256: "sha", size: 1)
        #expect(try #require(try j.listFiles().first).status == .archived)
    }
}
