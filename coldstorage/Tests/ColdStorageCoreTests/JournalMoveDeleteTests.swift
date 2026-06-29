import Testing
import Foundation
@testable import ColdStorageCore

/// `movePath`/`deletePath` are the journal edits behind the browser's reorganize (move/rename) + delete —
/// the tree lives in the journal (`relativePath`), never in S3 keys, so these are pure metadata rewrites.
/// These exercise the real SQLite path: the prefix sweep, `id` stability (the upsert dedup key must NOT
/// change, or a rescan would re-upload), the delete tombstone, and the `listFiles`/count exclusions.
@Suite struct JournalMoveDeleteTests {
    private func tempJournal() throws -> Journal {
        let path = FileManager.default.temporaryDirectory
            .appendingPathComponent("cs-movedel-\(ProcessInfo.processInfo.processIdentifier)-\(UUID().uuidString).sqlite").path
        return try Journal(path: path)
    }

    private func item(_ id: String, path: String, size: Int = 1) -> IngestItem {
        IngestItem(id: id, relativePath: path, size: size, contentHash: "h-\(id)",
                   createdAt: nil, isFavorite: false,
                   open: { AsyncThrowingStream { $0.finish() } })
    }

    /// id = the original relativePath at ingest. The browser's reorganize must rewrite the PATH while
    /// keeping that id — so we key lookups by id and assert the path moved under it.
    private func path(of j: Journal, id: String) throws -> String? {
        try j.listFiles().first { $0.id == id }?.relativePath
    }

    // MARK: - move == rename (single file)

    @Test func renameFileRewritesPathKeepsId() throws {
        let j = try tempJournal()
        try j.upsert([item("Photos/sunset.jpg", path: "Photos/sunset.jpg")])
        try j.movePath(from: "Photos/sunset.jpg", to: "Photos/beach.jpg")
        // Path moved, but the stable id (the dedup key) is unchanged — a rescan won't re-upload it.
        #expect(try path(of: j, id: "Photos/sunset.jpg") == "Photos/beach.jpg")
        #expect(try j.listFiles().count == 1)
    }

    @Test func moveFileToAnotherFolder() throws {
        let j = try tempJournal()
        try j.upsert([item("a/x.jpg", path: "a/x.jpg")])
        try j.movePath(from: "a/x.jpg", to: "b/x.jpg")
        #expect(try path(of: j, id: "a/x.jpg") == "b/x.jpg")
    }

    // MARK: - folder move/rename (prefix sweep over descendants)

    @Test func renameFolderSweepsDescendantsOnly() throws {
        let j = try tempJournal()
        try j.upsert([
            item("Photos/2024/a.jpg", path: "Photos/2024/a.jpg"),
            item("Photos/2024/sub/b.jpg", path: "Photos/2024/sub/b.jpg"),
            item("Photos/2023/c.jpg", path: "Photos/2023/c.jpg"),   // sibling — must NOT move
        ])
        try j.movePath(from: "Photos/2024", to: "Photos/archive")
        #expect(try path(of: j, id: "Photos/2024/a.jpg") == "Photos/archive/a.jpg")
        #expect(try path(of: j, id: "Photos/2024/sub/b.jpg") == "Photos/archive/sub/b.jpg")
        #expect(try path(of: j, id: "Photos/2023/c.jpg") == "Photos/2023/c.jpg")  // untouched
    }

    /// A folder name that is a string PREFIX of a sibling ("a" vs "ab/…") must not bleed across — the sweep
    /// keys on the `from/` boundary, not a bare `startsWith`.
    @Test func prefixBoundaryDoesNotBleed() throws {
        let j = try tempJournal()
        try j.upsert([
            item("a/one.jpg", path: "a/one.jpg"),
            item("ab/two.jpg", path: "ab/two.jpg"),
        ])
        try j.movePath(from: "a", to: "z")
        #expect(try path(of: j, id: "a/one.jpg") == "z/one.jpg")
        #expect(try path(of: j, id: "ab/two.jpg") == "ab/two.jpg")  // "ab" is not under "a/"
    }

    @Test func moveIntoSelfThrows() throws {
        let j = try tempJournal()
        try j.upsert([item("docs/a.pdf", path: "docs/a.pdf")])
        #expect(throws: ColdStorageError.self) { try j.movePath(from: "docs", to: "docs/inner") }
    }

    @Test func moveToSameIsNoop() throws {
        let j = try tempJournal()
        try j.upsert([item("a/x.jpg", path: "a/x.jpg")])
        try j.movePath(from: "a/x.jpg", to: "a/x.jpg")  // no-op, no throw
        #expect(try path(of: j, id: "a/x.jpg") == "a/x.jpg")
    }

    // MARK: - delete (tombstone)

    @Test func deleteFileTombstonesButKeepsRowAndBlob() throws {
        let j = try tempJournal()
        try j.upsert([item("a/x.jpg", path: "a/x.jpg")])
        try j.markFileArchived("a/x.jpg", blobId: "blob-1", offset: 0, length: 1, firstFrame: 0, plaintextSha256: "sha", size: 1)
        try j.deletePath("a/x.jpg")
        // Gone from the browse tree + the count…
        #expect(try j.listFiles().isEmpty)
        #expect(try j.summary().total == 0)
        // …but the row + its blob mapping survive (for a future repack/GC): restore can still locate it.
        #expect(try j.fileMapping("a/x.jpg")?.blobId == "blob-1")
    }

    @Test func deleteFolderTombstonesSubtreeOnly() throws {
        let j = try tempJournal()
        try j.upsert([
            item("trash/a.jpg", path: "trash/a.jpg"),
            item("trash/deep/b.jpg", path: "trash/deep/b.jpg"),
            item("keep/c.jpg", path: "keep/c.jpg"),
        ])
        try j.deletePath("trash")
        #expect(try j.listFiles().map(\.relativePath) == ["keep/c.jpg"])
    }
}
