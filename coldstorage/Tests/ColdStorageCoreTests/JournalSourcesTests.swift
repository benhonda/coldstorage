import XCTest
import Foundation
@testable import ColdStorageCore

/// The sources registry is the SSOT for what the daemon archives (design §3). These exercise the
/// real SQLite path — add/remove/list + idempotent re-add.
final class JournalSourcesTests: XCTestCase {
    private func tempJournal() throws -> Journal {
        let path = FileManager.default.temporaryDirectory
            .appendingPathComponent("cs-src-\(ProcessInfo.processInfo.processIdentifier)-\(UUID().uuidString).sqlite").path
        return try Journal(path: path)
    }

    func testAddListRemove() throws {
        let j = try tempJournal()
        XCTAssertEqual(try j.listSources().count, 0)

        try j.addSource(SourceRow(id: "/a/b", kind: .folder, path: "/a/b"))
        try j.addSource(SourceRow(id: "/c", kind: .folder, path: "/c"))
        let rows = try j.listSources()
        XCTAssertEqual(rows.map(\.id), ["/a/b", "/c"])          // ORDER BY id
        XCTAssertEqual(rows.first?.kind, .folder)
        XCTAssertEqual(rows.first?.path, "/a/b")

        try j.removeSource("/a/b")
        XCTAssertEqual(try j.listSources().map(\.id), ["/c"])
    }

    func testReAddIsIdempotent() throws {
        let j = try tempJournal()
        try j.addSource(SourceRow(id: "/a", kind: .folder, path: "/a"))
        try j.addSource(SourceRow(id: "/a", kind: .folder, path: "/a"))   // same id again
        XCTAssertEqual(try j.listSources().count, 1)
    }

    func testPhotosSourceHasNoPath() throws {
        let j = try tempJournal()
        try j.addSource(SourceRow(id: "photos", kind: .photos, path: nil))
        let row = try XCTUnwrap(try j.listSources().first)
        XCTAssertEqual(row.kind, .photos)
        XCTAssertNil(row.path)
    }
}
