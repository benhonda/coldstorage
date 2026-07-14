import Testing
import Foundation
@testable import ColdStorageCore

/// A single poison blob must not block the rest of the backup. These exercise the REAL pipeline — scan →
/// stage-encrypt → journal — with only the network (`BlobStore`) faked: one blob's upload throws a
/// permanent error; the other must still archive end-to-end, and the failed one must be skippable next pass.
@Suite struct UploadIsolationTests {
    /// Fake object store: every op succeeds except `uploadPart` for a key in `failKeys`. Records the keys
    /// it was asked to start an upload for, so a skipped blob can be proven *never attempted*.
    final class FakeStore: BlobStore, @unchecked Sendable {
        let failKeys: Set<String>
        private let lock = NSLock()
        private var _created: [String] = []
        var createdKeys: [String] { lock.withLock { _created } }
        init(failKeys: Set<String>) { self.failKeys = failKeys }

        func createUpload(key: String) async throws -> String {
            lock.withLock { _created.append(key) }
            return "upload-\(key)"
        }
        func existingParts(key: String, uploadId: String) async throws -> Set<Int> { [] }
        func uploadPart(key: String, uploadId: String, number: Int, data: Data) async throws -> (etag: String, sha: String) {
            if failKeys.contains(key) { throw ColdStorageError.staging("InvalidStorageClass (simulated permanent)") }
            return ("etag-\(number)", "sha-\(number)")
        }
        func complete(key: String, uploadId: String, parts: [PartRow]) async throws {}
        func verify(key: String) async throws {}
    }

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
        let blobs = BlobPlanner().plan(try await source.enumerate())
        #expect(blobs.count == 2)                                       // sanity: two separate blobs
        let bad = blobs[1]                                              // poison the second blob's upload

        let store = FakeStore(failKeys: [bad.s3Key])
        let (engine, journal) = try tempEngine(store: store)

        let failures = try await engine.run(source: source)

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
        let blobs = BlobPlanner().plan(try await source.enumerate())
        let bad = blobs[1]

        let store = FakeStore(failKeys: [bad.s3Key])
        let (engine, _) = try tempEngine(store: store)

        // Skipping the doomed blob means the store is never even asked to start its upload.
        let failures = try await engine.run(source: source, skipBlobIds: [bad.id])
        #expect(failures.isEmpty)
        #expect(!store.createdKeys.contains(bad.s3Key))
        #expect(store.createdKeys.contains(blobs[0].s3Key))            // the good blob still ran
    }
}
