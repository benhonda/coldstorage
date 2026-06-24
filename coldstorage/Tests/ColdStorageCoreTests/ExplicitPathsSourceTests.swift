import Testing
import Foundation
@testable import ColdStorageCore

/// The ad-hoc deposit source (drag-drop / "Choose files"). Placement is journal-relative: a dropped file
/// lands under `dest/<name>`, a dropped folder under `dest/<dirname>/…`. These exercise the real FS walk.
@Suite struct ExplicitPathsSourceTests {
    private func tempDir() throws -> URL {
        let d = FileManager.default.temporaryDirectory
            .appendingPathComponent("cs-deposit-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }

    @Test func droppedFileLandsUnderDest() async throws {
        let dir = try tempDir()
        let file = dir.appendingPathComponent("beach.jpg")
        try Data("hello".utf8).write(to: file)

        let src = ExplicitPathsSource(entries: [.init(url: file, destDir: "Photos/2019")])
        let items = try await src.enumerate()
        let it = try #require(items.first)
        #expect(items.count == 1)
        #expect(it.relativePath == "Photos/2019/beach.jpg")
        #expect(it.id == "Photos/2019/beach.jpg")
        #expect(it.size == 5)
    }

    @Test func droppedFileAtRootHasNoPrefix() async throws {
        let dir = try tempDir()
        let file = dir.appendingPathComponent("notes.txt")
        try Data("x".utf8).write(to: file)

        let items = try await ExplicitPathsSource(entries: [.init(url: file, destDir: "")]).enumerate()
        #expect(items.first?.relativePath == "notes.txt")
    }

    @Test func droppedFolderIsWalkedUnderDestSlashDirname() async throws {
        let root = try tempDir()
        let trip = root.appendingPathComponent("trip")
        try FileManager.default.createDirectory(at: trip, withIntermediateDirectories: true)
        try Data("a".utf8).write(to: trip.appendingPathComponent("a.jpg"))
        try Data("b".utf8).write(to: trip.appendingPathComponent("b.jpg"))

        let items = try await ExplicitPathsSource(entries: [.init(url: trip, destDir: "Photos")]).enumerate()
        let paths = Set(items.map(\.relativePath))
        #expect(paths == ["Photos/trip/a.jpg", "Photos/trip/b.jpg"])
    }

    @Test func vanishedPathIsSkippedNotFatal() async throws {
        let gone = URL(fileURLWithPath: "/no/such/path/\(UUID().uuidString).bin")
        let items = try await ExplicitPathsSource(entries: [.init(url: gone, destDir: "")]).enumerate()
        #expect(items.isEmpty)
    }
}
