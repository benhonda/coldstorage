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
        IngestItem(id: id, relativePath: path, size: size, content: .sha256("h-\(id)"),
                   isFavorite: false,
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

    /// The file's metadata captured at upsert survives to `listFiles` intact; a source with none → empty.
    @Test func metadataRoundTrips() throws {
        let j = try tempJournal()
        let m = FileMetadata(modifiedAt: 1_700_000_000, createdAt: 1_600_000_000, mode: 0o644, xattrs: ["user.tag": Data([1, 2])])
        try j.upsert([
            IngestItem(id: "dated", relativePath: "a.jpg", size: 1, content: .sha256("h1"),
                       isFavorite: false, metadata: m, open: { AsyncThrowingStream { $0.finish() } }),
            item("plain", path: "b.jpg", size: 1),
        ])
        let rows = try j.listFiles()
        #expect(rows.first(where: { $0.id == "dated" })?.metadata == m)
        #expect(rows.first(where: { $0.id == "plain" })?.metadata == FileMetadata())
        #expect(try j.fileMetadata("dated") == m)
    }

    /// A permanently-failed blob marks its files `failed` so the UI's ⚠ is journal truth, not a UI guess —
    /// it survives the next `listFiles` refresh (and a restart). Mirrors `DaemonService.performRun`.
    @Test func markFilesFailedPersistsFailedStatus() throws {
        let j = try tempJournal()
        try j.upsert([item("x", path: "a/b.jpg", size: 1), item("y", path: "a/c.jpg", size: 2)])
        try j.markFilesFailed(["x", "y"], kind: .permanent, error: "S3 AccessDenied")
        let rows = try j.listFiles()
        #expect(rows.allSatisfy { $0.status == .failed })
        // The KIND is what the app renders; the message stays as developer detail.
        #expect(rows.allSatisfy { $0.failureKind == .permanent && $0.error == "S3 AccessDenied" })
    }

    /// A later successful re-archive overwrites a prior `failed` back to `archived` (self-correcting after a
    /// transient-looking config fix on restart). And an empty id set is a no-op.
    @Test func reArchiveClearsFailedAndEmptyIsNoop() throws {
        let j = try tempJournal()
        try j.upsert([item("x", path: "a/b.jpg", size: 1)])
        try j.markFilesFailed([], kind: .permanent, error: "ignored")              // no-op, doesn't throw
        #expect(try #require(try j.listFiles().first).status == .planned)
        try j.markFilesFailed(["x"], kind: .permanent, error: "S3 AccessDenied")
        try j.markFileArchived("x", blobId: "blob-1", offset: 0, length: 1, firstFrame: 0, plaintextSha256: "sha", size: 1)
        #expect(try #require(try j.listFiles().first).status == .archived)
    }

    // MARK: - retry from the row (`retryFiles`)

    /// `sourcePath` rides on the row and is COALESCEd on re-upsert: a source that knows the path sets it,
    /// one that doesn't (a Photos asset, a synthetic item) must not erase it — that path is the only thing
    /// that makes a later "Try again" possible without asking the user where the file went.
    @Test func sourcePathPersistsAndSurvivesAPathlessUpsert() throws {
        let j = try tempJournal()
        try j.upsert([IngestItem(id: "x", relativePath: "a/b.jpg", size: 1, content: .sha256("h"), isFavorite: false, sourcePath: "/Users/me/b.jpg",
                                 open: { AsyncThrowingStream { $0.finish() } })])
        #expect(try #require(try j.listFiles().first).sourcePath == "/Users/me/b.jpg")
        try j.upsert([item("x", path: "a/b.jpg", size: 1)])   // helper carries no sourcePath
        #expect(try #require(try j.listFiles().first).sourcePath == "/Users/me/b.jpg")
        try j.setSourcePath(id: "x", "/Volumes/T7/b.jpg")     // the user's Locate…
        #expect(try #require(try j.files(ids: ["x"]).first).sourcePath == "/Volumes/T7/b.jpg")
    }

    /// "Try again" requeues ONLY failed rows, as a fresh claim (no stale error, no attempt clock) — an
    /// archived file has nothing to retry and a queued one is already in flight. Returns exactly what flipped.
    @Test func requeueFailedFilesFlipsOnlyFailedRowsClean() throws {
        let j = try tempJournal()
        try j.upsert([item("f", path: "f.jpg", size: 1), item("a", path: "a.jpg", size: 1), item("q", path: "q.jpg", size: 1)])
        try j.markFilesFailed(["f"], kind: .permanent, error: "boom")
        try j.markFileArchived("a", blobId: "b", offset: 0, length: 1, firstFrame: 0, plaintextSha256: "s", size: 1)
        #expect(try j.requeueFailedFiles(ids: ["f", "a", "q", "nope"]) == ["f"])
        let byId = Dictionary(uniqueKeysWithValues: try j.listFiles().map { ($0.id, $0) })
        #expect(byId["f"]?.status == .planned)
        #expect(byId["f"]?.error == nil)
        #expect(byId["f"]?.lastAttemptAt == nil)
        #expect(byId["a"]?.status == .archived)
        #expect(byId["q"]?.status == .planned)
        #expect(try j.requeueFailedFiles(ids: []).isEmpty)
    }

    /// The retry source re-ingests the SAME row (id + relativePath, even one renamed since the drop) from
    /// its recorded source, and skips rows whose source is missing or was never recorded — never invents a
    /// second file next to the failed one.
    @Test func retrySourceReingestsSameRowFromSourcePath() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("cs-retry-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let onDisk = dir.appendingPathComponent("orig.jpg")
        try Data("hello".utf8).write(to: onDisk)
        let rows = [
            FileRow(id: "keep", relativePath: "Renamed/new-name.jpg", size: 0, status: .failed, blobId: nil, sourcePath: onDisk.path),
            FileRow(id: "gone", relativePath: "x.jpg", size: 0, status: .failed, blobId: nil, sourcePath: dir.appendingPathComponent("gone.jpg").path),
            FileRow(id: "never", relativePath: "y.jpg", size: 0, status: .failed, blobId: nil, sourcePath: nil),
        ]
        let items = try await RetryFilesSource(rows: rows).enumerate()
        #expect(items.map(\.id) == ["keep"])
        let it = try #require(items.first)
        #expect(it.relativePath == "Renamed/new-name.jpg")
        #expect(it.size == 5)
        #expect(it.sourcePath == onDisk.path)
        #expect(it.content.planKey == (try LocalDirSource.sha256Hex(of: onDisk)))
    }

    /// A mass failure is one cause across a whole drop — more rows than SQLite will bind in one `IN (…)`
    /// (32,766). The id-taking reads and the requeue must chunk, and "everything failed" must come from the
    /// journal itself rather than a client-sent list.
    @Test func idSetsBeyondTheBindLimitAreChunked() throws {
        let j = try tempJournal()
        let n = 40_000
        try j.upsert((0..<n).map { item("f\($0)", path: "drop/\($0).bin", size: 1) })
        let ids = (0..<n).map { "f\($0)" }
        try j.markFilesFailed(ids, kind: .permanent, error: "AccessDenied")
        #expect(try j.failedFiles().count == n)
        #expect(try j.files(ids: ids).count == n)
        #expect(try j.requeueFailedFiles(ids: ids).count == n)
        #expect(try j.failedFiles().isEmpty)
    }

    /// A failed PHOTO row retries too: its `photos:<id>` source is re-resolved and the asset re-keyed onto
    /// the row (same id, same vault path). A stale asset the resolver drops is simply absent.
    @Test func retrySourceReresolvesPhotoRowsOntoTheirRows() async throws {
        struct FakeResolver: PhotoResolver {
            func resolve(assetIds: [String], scratchDir: URL) async throws -> [IngestItem] {
                assetIds.filter { $0 == "asset-1" }.map {
                    IngestItem(id: $0, relativePath: "IMG_0001.HEIC", size: 9, content: .opaque("k"),
                               isFavorite: true, open: { AsyncThrowingStream { $0.finish() } })
                }
            }
        }
        let rows = [
            FileRow(id: "p1", relativePath: "Trip/renamed.heic", size: 0, status: .failed, blobId: nil, sourcePath: IngestItem.photoSourcePrefix + "asset-1"),
            FileRow(id: "p2", relativePath: "Trip/gone.heic", size: 0, status: .failed, blobId: nil, sourcePath: IngestItem.photoSourcePrefix + "asset-stale"),
        ]
        let scratch = FileManager.default.temporaryDirectory
        let items = try await RetryFilesSource(rows: rows, photos: (resolver: FakeResolver(), scratchDir: scratch)).enumerate()
        #expect(items.map(\.id) == ["p1"])
        #expect(items.first?.relativePath == "Trip/renamed.heic")
        #expect(items.first?.size == 9)
        // No resolver on this platform ⇒ photo rows are skipped, never mis-read as paths.
        #expect(try await RetryFilesSource(rows: rows).enumerate().isEmpty)
    }
}
