import Testing
import Foundation
@testable import ColdStorageCore

/// The deposit PREVIEW answers one question — "what would land where, and does it already exist" — and it
/// used to answer it by calling `enumerate`, which SHA-256s every file. That is a full read of every byte in
/// the drop, thrown away immediately, in front of a UI that times out after 10 seconds. A 1000-file deposit
/// looked hung before a single row appeared (2026-07-14).
///
/// `previewPaths` must therefore be **stat-only** — and it must still agree with `enumerate` about placement,
/// or the collision prompt would lie about the very deposit it is previewing.
@Suite struct DepositPreviewTests {

    private func drop() throws -> (root: URL, base: URL) {
        let fm = FileManager.default
        let base = fm.temporaryDirectory.appendingPathComponent("cs-preview-\(UUID().uuidString)")
        let root = base.appendingPathComponent("Trip")
        try fm.createDirectory(at: root.appendingPathComponent("nested"), withIntermediateDirectories: true)
        try Data("one".utf8).write(to: root.appendingPathComponent("a.txt"))
        try Data("two".utf8).write(to: root.appendingPathComponent("b.txt"))
        try Data("three".utf8).write(to: root.appendingPathComponent("nested/c.txt"))
        return (root, base)
    }

    /// **The proof that it reads no bytes.** A file whose contents cannot be read at all: hashing it throws.
    /// So if the preview still succeeds, it demonstrably never opened the file — which no timing assertion
    /// could establish as reliably.
    @Test func previewNeverOpensTheFiles() async throws {
        let d = try drop()
        defer {
            try? FileManager.default.setAttributes([.posixPermissions: 0o644],
                                                   ofItemAtPath: d.root.appendingPathComponent("a.txt").path)
            try? FileManager.default.removeItem(at: d.base)
        }
        let unreadable = d.root.appendingPathComponent("a.txt")
        try FileManager.default.setAttributes([.posixPermissions: 0o000], ofItemAtPath: unreadable.path)

        let source = ExplicitPathsSource(entries: [.init(url: d.root, destDir: "Photos")])

        // Reading the bytes is impossible…
        await #expect(throws: (any Error).self) { try await source.enumerate() }
        // …yet the preview answers fine, because it only ever stats.
        let paths = try await source.previewPaths().map(\.relativePath)
        #expect(paths.sorted() == ["Photos/Trip/a.txt", "Photos/Trip/b.txt", "Photos/Trip/nested/c.txt"])
    }

    /// Placement is one SSOT: a preview that disagreed with the deposit would prompt about the wrong
    /// collisions, or miss real ones. The preview now also carries each item's SIZE (for the UI's quota
    /// gate), which must likewise agree with what the deposit records.
    @Test func previewPlacementMatchesTheDepositExactly() async throws {
        let d = try drop()
        defer { try? FileManager.default.removeItem(at: d.base) }

        let source = ExplicitPathsSource(entries: [.init(url: d.root, destDir: "Photos")])
        let previewed = try await source.previewPaths().sorted { $0.relativePath < $1.relativePath }
        let archived = try await source.enumerate().sorted { $0.relativePath < $1.relativePath }

        #expect(previewed.map(\.relativePath) == archived.map(\.relativePath))
        #expect(previewed.map(\.size) == archived.map(\.size))   // sizes agree, not just paths
        #expect(!previewed.isEmpty)   // guard: the equalities above are not vacuously true
    }

    /// Excludes are applied during the walk, so the preview must honour them too — otherwise it would prompt
    /// about `node_modules` files the deposit is never going to upload.
    @Test func previewHonoursExcludes() async throws {
        let d = try drop()
        defer { try? FileManager.default.removeItem(at: d.base) }

        let source = ExplicitPathsSource(entries: [.init(url: d.root, destDir: "")],
                                         exclude: ExcludeMatcher(patterns: ["nested"]))
        #expect(try await source.previewPaths().map(\.relativePath).sorted() == ["Trip/a.txt", "Trip/b.txt"])
    }
}
