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
}
