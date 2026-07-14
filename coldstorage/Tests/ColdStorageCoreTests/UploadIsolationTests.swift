import Testing
import Foundation
@testable import ColdStorageCore

/// A single poison blob must not block the rest of the backup. These exercise the REAL pipeline — scan →
/// stage-encrypt → journal — with only the network (`BlobStore`) faked: one blob's upload throws a
/// permanent error; the other must still archive end-to-end, and the failed one must be skippable next pass.
@Suite struct UploadIsolationTests {

    /// Two small files in DIFFERENT subdirs → the planner emits two separate blobs (dir change flushes).
    private func twoBlobSource() throws -> (root: URL, source: LocalDirSource) {
        let fm = FileManager.default
        let root = fm.temporaryDirectory.appendingPathComponent("cs-iso-\(UUID().uuidString)")
        try fm.createDirectory(at: root.appendingPathComponent("a"), withIntermediateDirectories: true)
        try fm.createDirectory(at: root.appendingPathComponent("b"), withIntermediateDirectories: true)
        try Data("alpha file contents".utf8).write(to: root.appendingPathComponent("a/one.bin"))
        try Data("bravo file contents".utf8).write(to: root.appendingPathComponent("b/two.bin"))
        return (root, LocalDirSource(root: root))
    }

    private func tempEngine(store: any BlobStore) throws -> (UploadEngine, Journal) {
        let fm = FileManager.default
        let base = fm.temporaryDirectory.appendingPathComponent("cs-iso-\(UUID().uuidString)")
        try fm.createDirectory(at: base, withIntermediateDirectories: true)
        let journal = try Journal(path: base.appendingPathComponent("j.sqlite").path)
        let engine = UploadEngine(journal: journal, store: store,
                                  keys: LocalFileKEK(path: base.appendingPathComponent("kek.bin").path))
        return (engine, journal)
    }

    @Test func oneBadBlobDoesNotBlockTheGoodOne() async throws {
        let (root, source) = try twoBlobSource()
        defer { try? FileManager.default.removeItem(at: root) }
        let blobs = BlobPlanner().plan(try await source.enumerate(), prefix: .dev)
        #expect(blobs.count == 2)                                       // sanity: two separate blobs
        let bad = blobs[1]                                              // poison the second blob's upload

        let store = FakeVault(failKeys: [bad.s3Key])
        let (engine, journal) = try tempEngine(store: store)

        let failures = try await engine.run(source: source, prefix: .dev)

        #expect(failures.count == 1)                                   // isolated, not fatal
        #expect(failures.first?.blobId == bad.id)
        #expect(failures.first?.kind.isPermanent == true)
        #expect(failures.first?.files.map(\.id) == bad.items.map(\.id))     // names the files in the poison blob
        #expect(failures.first?.files.map(\.path) == bad.items.map(\.relativePath))
        #expect(!bad.items.isEmpty)                                         // guard: assertions above are non-vacuous
        #expect(try journal.isBlobVerified(blobs[0].id) == true)       // the good blob archived end-to-end
        #expect(try journal.isBlobVerified(bad.id) == false)
    }

    @Test func skippedBlobIsNeverAttempted() async throws {
        let (root, source) = try twoBlobSource()
        defer { try? FileManager.default.removeItem(at: root) }
        let blobs = BlobPlanner().plan(try await source.enumerate(), prefix: .dev)
        let bad = blobs[1]

        let store = FakeVault(failKeys: [bad.s3Key])
        let (engine, _) = try tempEngine(store: store)

        // Skipping the doomed blob means the store is never even asked to start its upload.
        let failures = try await engine.run(source: source, skipBlobIds: [bad.id], prefix: .dev)
        #expect(failures.isEmpty)
        #expect(!store.createdKeys.contains(bad.s3Key))
        #expect(store.createdKeys.contains(blobs[0].s3Key))            // the good blob still ran
    }
}
