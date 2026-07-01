import Testing
import Foundation
@testable import ColdStorageCore

/// Multi-user isolation (PROD.md Phase 2): every blob must land under the caller's per-user S3 prefix
/// (`blobs/<cognito-identity-id>/…`), because the IAM role scopes temp creds to `blobs/${sub}/*`. These
/// prove the prefix (a) reaches the actual S3 PUT and (b) is persisted as the blob's `s3Key` — which is the
/// exact value RestoreEngine reads back (SSOT), so upload and restore agree on where the bytes are.
@Suite struct PerUserPrefixTests {
    /// Records the keys it was asked to create an upload for — so we can assert the per-user prefix.
    final class RecordingStore: BlobStore, @unchecked Sendable {
        private let lock = NSLock()
        private var _created: [String] = []
        var createdKeys: [String] { lock.withLock { _created } }
        func createUpload(key: String) async throws -> String { lock.withLock { _created.append(key) }; return "u-\(key)" }
        func existingParts(key: String, uploadId: String) async throws -> Set<Int> { [] }
        func uploadPart(key: String, uploadId: String, number: Int, data: Data) async throws -> (etag: String, sha: String) {
            ("etag-\(number)", "sha-\(number)")
        }
        func complete(key: String, uploadId: String, parts: [PartRow]) async throws {}
        func verify(key: String) async throws {}
    }

    private func fixture() throws -> (engine: UploadEngine, journal: Journal, store: RecordingStore, source: LocalDirSource, base: URL) {
        let fm = FileManager.default
        let base = fm.temporaryDirectory.appendingPathComponent("cs-prefix-\(UUID().uuidString)")
        let root = base.appendingPathComponent("data")
        try fm.createDirectory(at: root, withIntermediateDirectories: true)
        try Data("a signed-in user's file".utf8).write(to: root.appendingPathComponent("f.bin"))
        let journal = try Journal(path: base.appendingPathComponent("j.sqlite").path)
        let keys = LocalFileKEK(path: base.appendingPathComponent("kek.bin").path)
        let store = RecordingStore()
        let engine = UploadEngine(journal: journal, store: store, keys: keys, stagingDir: base.appendingPathComponent("staging"))
        return (engine, journal, store, LocalDirSource(root: root), base)
    }

    @Test func perUserPrefixReachesS3AndIsPersistedForRestore() async throws {
        let f = try fixture()
        defer { try? FileManager.default.removeItem(at: f.base) }

        let items = try await f.source.enumerate()
        let prefix = "blobs/ca-central-1:11111111-2222-3333-4444-555555555555"   // a Cognito identity id
        _ = try await f.engine.run(source: f.source, keyPrefix: prefix)

        // The blob id is content-derived (prefix-independent) — recompute it to know the expected key.
        let blob = BlobPlanner().plan(items, keyPrefix: prefix)[0]
        let expectedKey = "\(prefix)/\(blob.id)"

        #expect(f.store.createdKeys == [expectedKey])                       // the real S3 PUT went to the user's prefix
        #expect(try f.journal.blobS3Key(blob.id) == expectedKey)           // and restore will read the SAME key (SSOT)
        #expect(try f.journal.isFileArchived(items[0].id) == true)         // file linked through the full pipeline
    }

    @Test func defaultPrefixIsBlobsSoSingleUserPathIsUnchanged() async throws {
        let f = try fixture()
        defer { try? FileManager.default.removeItem(at: f.base) }

        let items = try await f.source.enumerate()
        _ = try await f.engine.run(source: f.source)                        // no keyPrefix → default "blobs"
        let blob = BlobPlanner().plan(items)[0]

        #expect(f.store.createdKeys == ["blobs/\(blob.id)"])
        #expect(try f.journal.blobS3Key(blob.id) == "blobs/\(blob.id)")
    }
}
