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

/// Symlinks are not backed up — and that must be a FACT the preview reports, never a file that quietly
/// fails to appear.
@Suite struct SymlinkSkipTests {
    @Test func aSymlinkInsideADroppedFolderIsReportedNotArchived() async throws {
        let fm = FileManager.default
        let root = fm.temporaryDirectory.appendingPathComponent("cs-symlink-\(UUID().uuidString)")
        let folder = root.appendingPathComponent("trip")
        try fm.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: root) }
        try Data("real".utf8).write(to: folder.appendingPathComponent("real.txt"))
        try fm.createSymbolicLink(at: folder.appendingPathComponent("link.txt"), withDestinationURL: folder.appendingPathComponent("real.txt"))

        let src = ExplicitPathsSource(entries: [.init(url: folder, destDir: "")])
        let preview = try await src.previewPaths()
        #expect(preview.paths.map(\.relativePath) == ["trip/real.txt"])
        #expect(preview.skipped == [.init(relativePath: "trip/link.txt", reason: .symlink)])
        #expect(try await src.enumerate().map(\.relativePath) == ["trip/real.txt"])
    }

    /// `fileExists(isDirectory:)` follows links — so without the symlink check coming first, a link to a
    /// folder would be walked as that folder and its contents uploaded as copies.
    @Test func aDroppedSymlinkToAFolderIsNotWalked() async throws {
        let fm = FileManager.default
        let root = fm.temporaryDirectory.appendingPathComponent("cs-symlink-\(UUID().uuidString)")
        let real = root.appendingPathComponent("real")
        try fm.createDirectory(at: real, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: root) }
        try Data("x".utf8).write(to: real.appendingPathComponent("inside.txt"))
        let link = root.appendingPathComponent("shortcut")
        try fm.createSymbolicLink(at: link, withDestinationURL: real)

        let src = ExplicitPathsSource(entries: [.init(url: link, destDir: "")])
        let preview = try await src.previewPaths()
        #expect(preview.paths.isEmpty)
        #expect(preview.skipped == [.init(relativePath: "shortcut", reason: .symlink)])
        #expect(try await src.enumerate().isEmpty)
    }

    @Test func aDroppedSymlinkItselfIsReportedNotArchived() async throws {
        let fm = FileManager.default
        let root = fm.temporaryDirectory.appendingPathComponent("cs-symlink-\(UUID().uuidString)")
        try fm.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: root) }
        let target = root.appendingPathComponent("real.txt")
        try Data("real".utf8).write(to: target)
        let link = root.appendingPathComponent("alias.txt")
        try fm.createSymbolicLink(at: link, withDestinationURL: target)

        let src = ExplicitPathsSource(entries: [.init(url: link, destDir: "Docs")])
        let preview = try await src.previewPaths()
        #expect(preview.paths.isEmpty)
        #expect(preview.skipped == [.init(relativePath: "Docs/alias.txt", reason: .symlink)])
        #expect(try await src.enumerate().isEmpty)
    }
}
