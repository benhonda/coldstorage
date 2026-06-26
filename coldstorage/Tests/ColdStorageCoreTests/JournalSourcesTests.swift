import Testing
import Foundation
@testable import ColdStorageCore

/// The sources registry is the SSOT for what the daemon archives (design §3). These exercise the
/// real SQLite path — add/remove/list + idempotent re-add.
@Suite struct JournalSourcesTests {
    private func tempJournal() throws -> Journal {
        let path = FileManager.default.temporaryDirectory
            .appendingPathComponent("cs-src-\(ProcessInfo.processInfo.processIdentifier)-\(UUID().uuidString).sqlite").path
        return try Journal(path: path)
    }

    @Test func addListRemove() throws {
        let j = try tempJournal()
        #expect(try j.listSources().count == 0)

        try j.addSource(SourceRow(id: "/a/b", kind: .folder, path: "/a/b"))
        try j.addSource(SourceRow(id: "/c", kind: .folder, path: "/c"))
        let rows = try j.listSources()
        #expect(rows.map(\.id) == ["/a/b", "/c"])          // ORDER BY id
        #expect(rows.first?.kind == .folder)
        #expect(rows.first?.path == "/a/b")

        try j.removeSource("/a/b")
        #expect(try j.listSources().map(\.id) == ["/c"])
    }

    @Test func reAddIsIdempotent() throws {
        let j = try tempJournal()
        try j.addSource(SourceRow(id: "/a", kind: .folder, path: "/a"))
        try j.addSource(SourceRow(id: "/a", kind: .folder, path: "/a"))   // same id again
        #expect(try j.listSources().count == 1)
    }

    @Test func photosSourceHasNoPath() throws {
        let j = try tempJournal()
        try j.addSource(SourceRow(id: "photos", kind: .photos, path: nil))
        let row = try #require(try j.listSources().first)
        #expect(row.kind == .photos)
        #expect(row.path == nil)
    }

    /// mountPath is the destination a watched folder lands under in the drive — it must round-trip and
    /// be overwritten by an idempotent re-add (re-pointing the mount).
    @Test func mountPathRoundTripsAndUpdates() throws {
        let j = try tempJournal()
        try j.addSource(SourceRow(id: "/a/b", kind: .folder, path: "/a/b", mountPath: "Backups/Photos"))
        #expect(try j.listSources().first?.mountPath == "Backups/Photos")

        try j.addSource(SourceRow(id: "/a/b", kind: .folder, path: "/a/b", mountPath: "Archive"))  // re-point
        let rows = try j.listSources()
        #expect(rows.count == 1)
        #expect(rows.first?.mountPath == "Archive")
    }

    /// An empty folder is anchored by a `folder`-status marker row so it survives a reload (the tree is
    /// otherwise derived from file paths). It shows in `listFiles`, doesn't count as a file, and is
    /// idempotent on the path. `movePath` renames it and `deletePath` tombstones it like any other row.
    @Test func emptyFolderMarkerPersistsCountsAndSweeps() throws {
        let j = try tempJournal()
        try j.createFolder(path: "Photos")
        try j.createFolder(path: "Photos")                       // idempotent on the path — no duplicate

        let listed = try j.listFiles()
        #expect(listed.filter { $0.relativePath == "Photos" }.count == 1)
        #expect(listed.first(where: { $0.relativePath == "Photos" })?.status == .folder)
        #expect(try j.summary().total == 0)                      // a marker is not a file

        try j.movePath(from: "Photos", to: "Memories")           // rename sweeps the marker
        #expect(try j.listFiles().map(\.relativePath) == ["Memories"])

        try j.deletePath("Memories")                             // delete tombstones it → gone from listFiles
        #expect(try j.listFiles().isEmpty)
    }

    /// A marker is a no-op when a real file already implies the folder — we never stack a redundant marker.
    @Test func createFolderIsNoOpWhenPathAlreadyHasAFile() throws {
        let j = try tempJournal()
        try j.upsert([IngestItem(id: "f1", relativePath: "Photos/a.jpg", size: 10, contentHash: "h1",
                                 createdAt: nil, isFavorite: false,
                                 open: { AsyncThrowingStream { $0.finish() } })])
        try j.createFolder(path: "Photos")
        #expect(try j.listFiles().filter { $0.relativePath == "Photos" }.isEmpty)   // no marker added
    }

    /// Per-source pause is journal-backed (persists), defaults false, and toggles without re-adding.
    @Test func pausedRoundTripsAndToggles() throws {
        let j = try tempJournal()
        try j.addSource(SourceRow(id: "/a", kind: .folder, path: "/a"))
        #expect(try j.listSources().first?.paused == false)   // default

        try j.setSourcePaused("/a", true)
        #expect(try j.listSources().first?.paused == true)
        try j.setSourcePaused("/a", false)
        #expect(try j.listSources().first?.paused == false)

        // setting an unknown id is a harmless no-op (doesn't create a row)
        try j.setSourcePaused("/nope", true)
        #expect(try j.listSources().count == 1)
    }
}
