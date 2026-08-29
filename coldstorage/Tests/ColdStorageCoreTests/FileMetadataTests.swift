import Testing
import Foundation
@testable import ColdStorageCore

/// The file beyond its bytes — captured at ingest, put back on restore. A backup that returns the bytes
/// with today's date and no tags is a backup that lost something; these pin that it doesn't.
@Suite struct FileMetadataTests {
    private func tempDir() throws -> URL {
        let d = FileManager.default.temporaryDirectory.appendingPathComponent("cs-meta-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }

    @Test func captureReadsDatesAndMode() throws {
        let dir = try tempDir(); defer { try? FileManager.default.removeItem(at: dir) }
        let f = dir.appendingPathComponent("script.sh")
        try Data("#!/bin/sh\n".utf8).write(to: f)
        let then = Date(timeIntervalSince1970: 1_600_000_000)
        try FileManager.default.setAttributes([.modificationDate: then, .posixPermissions: 0o755], ofItemAtPath: f.path)

        let m = FileMetadata.capture(at: f)
        #expect(m.modifiedAt == 1_600_000_000)
        #expect(m.mode == 0o755)
        #expect(m.photo == nil)
    }

    @Test func applyPutsDatesAndModeBack() throws {
        let dir = try tempDir(); defer { try? FileManager.default.removeItem(at: dir) }
        let f = dir.appendingPathComponent("restored.txt")
        try Data("x".utf8).write(to: f)
        let m = FileMetadata(modifiedAt: 1_500_000_000, mode: 0o640)
        #expect(m.apply(to: f).isEmpty)

        let attrs = try FileManager.default.attributesOfItem(atPath: f.path)
        #expect((attrs[.modificationDate] as? Date).map { Int($0.timeIntervalSince1970) } == 1_500_000_000)
        #expect((attrs[.posixPermissions] as? Int) == 0o640)
    }

    /// xattrs round-trip through capture → JSON (the journal column) → apply. The write is skipped, not
    /// failed, on a filesystem that has no xattr support (some CI tmpfs) — but the JSON leg always runs.
    @Test func xattrsRoundTripThroughJSON() throws {
        let dir = try tempDir(); defer { try? FileManager.default.removeItem(at: dir) }
        let src = dir.appendingPathComponent("tagged.txt")
        try Data("x".utf8).write(to: src)
        // Linux only honours the `user.` namespace for unprivileged callers; macOS takes any name.
        #if canImport(Darwin)
        let name = "com.apple.metadata:_kMDItemUserTags"
        #else
        let name = "user.com.apple.metadata:_kMDItemUserTags"
        #endif
        let tag = Data("bplist-Red".utf8)
        let seeded = FileMetadata(xattrs: [name: tag]).apply(to: src)
        guard seeded.isEmpty else { return }   // no xattr support here — nothing to round-trip

        let captured = FileMetadata.capture(at: src)
        #expect(captured.xattrs[name] == tag)

        let json = try captured.json()
        let decoded = try #require(FileMetadata.from(json: json))
        #expect(decoded == captured)

        let dst = dir.appendingPathComponent("copy.txt")
        try Data("x".utf8).write(to: dst)
        #expect(decoded.apply(to: dst).isEmpty)
        #expect(FileMetadata.capture(at: dst).xattrs[name] == tag)
    }

    @Test func quarantineNeverTravels() throws {
        // The deny-list is the product decision that a restored download must not re-prompt Gatekeeper.
        #expect(FileMetadata.droppedXattrs.contains("com.apple.quarantine"))
    }

    @Test func jsonIsDeterministic() throws {
        let m = FileMetadata(modifiedAt: 1, createdAt: 2, mode: 0o644, xattrs: ["b": Data([2]), "a": Data([1])])
        #expect(try m.json() == (try m.json()))
        #expect(try m.json().contains("\"a\":"))
        #expect(FileMetadata.from(json: try m.json()) == m)
        #expect(FileMetadata.from(json: nil) == nil)
    }

    @Test func dateIsModifiedElseCreated() {
        #expect(FileMetadata(modifiedAt: 5, createdAt: 3).date == 5)
        #expect(FileMetadata(createdAt: 3).date == 3)
        #expect(FileMetadata().date == nil)
    }
}
