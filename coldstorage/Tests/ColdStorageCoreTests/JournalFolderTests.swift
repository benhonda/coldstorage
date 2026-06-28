import Testing
import Foundation
@testable import ColdStorageCore

/// Regression coverage for `createFolder`'s marker IDENTITY (basic create/idempotency/file-implies-folder
/// already live in `JournalSourcesTests`). The bug these pin made the UI's "New folder" flicker-then-vanish:
/// the marker id must be UNIQUE, not path-derived. `movePath` keeps a marker's id stable while rewriting its
/// `relativePath`, so a path-derived id (`folder:<path>`) outlives its path and collides the next time that
/// path is reused — the plain `INSERT` hits the PK and (before `run()` was hardened to surface a failed
/// step) silently dropped the new marker, so `createFolder` returned ok while writing nothing.
@Suite struct JournalFolderTests {
    private func tempJournal() throws -> Journal {
        let path = FileManager.default.temporaryDirectory
            .appendingPathComponent("cs-folder-\(ProcessInfo.processInfo.processIdentifier)-\(UUID().uuidString).sqlite").path
        return try Journal(path: path)
    }

    private func folders(_ j: Journal) throws -> [String] {
        try j.listFiles().filter { $0.status == .folder }.map(\.relativePath).sorted()
    }

    /// THE REGRESSION: create a folder, rename it, then create another folder whose path equals the FIRST
    /// one's ORIGINAL path. With a path-derived id both markers share `folder:untitled folder` and the second
    /// INSERT collides → the new folder vanishes. With a unique id, both coexist. (Reproduces the real flow:
    /// every "New folder" defaults to "untitled folder", so the 2nd one onward collided once the 1st was
    /// renamed away.)
    @Test func recreatingARenamedFoldersPathKeepsBothMarkers() throws {
        let j = try tempJournal()
        try j.createFolder(path: "untitled folder")            // marker #1
        try j.movePath(from: "untitled folder", to: "Keepers") // id stays, relativePath → "Keepers"
        try j.createFolder(path: "untitled folder")            // marker #2 — must NOT collide on the id
        #expect(try folders(j) == ["Keepers", "untitled folder"])
    }

    /// Re-creating a folder at a path that was DELETED (tombstoned) must work too — the tombstoned row keeps
    /// its old id and the fresh marker gets its own, so no PK collision and no silently-dropped INSERT.
    @Test func recreatingADeletedFoldersPathWorks() throws {
        let j = try tempJournal()
        try j.createFolder(path: "Scratch")
        try j.deletePath("Scratch")                            // tombstone (row kept, status=deleted)
        #expect(try folders(j).isEmpty)
        try j.createFolder(path: "Scratch")                    // a brand-new empty folder at the same path
        #expect(try folders(j) == ["Scratch"])
    }
}
