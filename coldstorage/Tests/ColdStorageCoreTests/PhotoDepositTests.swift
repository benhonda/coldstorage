import Testing
import Foundation
@testable import ColdStorageCore

/// The explicit photo-deposit path (the photo analogue of the file `deposit`). A photo is picked by id,
/// resolved to a full-res byte stream by a `PhotoResolver` (Mac PhotoKit in prod), placed under a browser
/// folder, and archived through the SAME proven pipeline as files. These fake only PhotoKit (the resolver)
/// and the network (`BlobStore`); the encrypt → plan → stage → journal core is real.
@Suite struct PhotoDepositTests {
    /// Stands in for PhotoKit: returns one item per requested id (echoing the proven `PhotoKitResolver`
    /// shape — id = the asset's localIdentifier, relativePath = its original filename), streaming canned
    /// bytes. An id absent from `library` is dropped, exercising the "stale pick is skipped, not fatal" rule.
    struct FakeResolver: PhotoResolver {
        /// assetId → (originalFilename, plaintext bytes)
        let library: [String: (name: String, data: Data)]
        func resolve(assetIds: [String]) async -> [IngestItem] {
            assetIds.compactMap { id in
                guard let a = library[id] else { return nil }
                return IngestItem(id: id, relativePath: a.name, size: a.data.count, contentHash: id,
                                  createdAt: nil, isFavorite: false, metadata: ["uti": "public.jpeg"],
                                  open: { AsyncThrowingStream { c in c.yield(a.data); c.finish() } })
            }
        }
    }

    /// Always-succeed object store that records the bytes it was handed — so a test can prove the photo's
    /// plaintext was genuinely encrypted (ciphertext on the wire ≠ the original bytes).
    final class RecordingStore: BlobStore, @unchecked Sendable {
        private let lock = NSLock()
        private var _uploaded = Data()
        var uploaded: Data { lock.withLock { _uploaded } }
        func createUpload(key: String) async throws -> String { "upload-\(key)" }
        func existingParts(key: String, uploadId: String) async throws -> Set<Int> { [] }
        func uploadPart(key: String, uploadId: String, number: Int, data: Data) async throws -> (etag: String, sha: String) {
            lock.withLock { _uploaded.append(data) }
            return ("etag-\(number)", "sha-\(number)")
        }
        func complete(key: String, uploadId: String, parts: [PartRow]) async throws {}
        func verify(key: String) async throws {}
    }

    private func tempEngine(store: any BlobStore) throws -> (UploadEngine, Journal) {
        let base = FileManager.default.temporaryDirectory.appendingPathComponent("cs-photo-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        let journal = try Journal(path: base.appendingPathComponent("j.sqlite").path)
        let engine = UploadEngine(journal: journal, store: store,
                                  keys: LocalFileKEK(path: base.appendingPathComponent("kek.bin").path),
                                  stagingDir: base.appendingPathComponent("staging"))
        return (engine, journal)
    }

    // MARK: - source mapping (pure)

    @Test func picksAreMountedUnderDestButKeepAssetIdentity() async throws {
        let resolver = FakeResolver(library: ["asset-1": ("IMG_0001.jpg", Data("a".utf8))])
        let items = try await PhotoDepositSource(resolver: resolver, assetIds: ["asset-1"], destDir: "Photos/2019").enumerate()
        let it = try #require(items.first)
        #expect(items.count == 1)
        #expect(it.relativePath == "Photos/2019/IMG_0001.jpg")  // re-based under the picked folder for display
        #expect(it.id == "asset-1")                              // …but id stays the asset's stable identity
    }

    @Test func picksAtRootHaveNoPrefix() async throws {
        let resolver = FakeResolver(library: ["asset-1": ("IMG_0001.jpg", Data("a".utf8))])
        let items = try await PhotoDepositSource(resolver: resolver, assetIds: ["asset-1"], destDir: "").enumerate()
        #expect(items.first?.relativePath == "IMG_0001.jpg")
    }

    @Test func staleOrUnknownPickIsSkippedNotFatal() async throws {
        let resolver = FakeResolver(library: ["asset-1": ("IMG_0001.jpg", Data("a".utf8))])
        let items = try await PhotoDepositSource(resolver: resolver, assetIds: ["asset-1", "gone"], destDir: "").enumerate()
        #expect(items.map(\.id) == ["asset-1"])  // the missing id is dropped, the present one survives
    }

    // MARK: - end-to-end through the real pipeline

    @Test func depositedPhotosArchiveThroughTheRealPipeline() async throws {
        let plaintext = Data("PHOTO-BYTES-distinctive-marker-\(UUID().uuidString)".utf8)
        let resolver = FakeResolver(library: [
            "asset-1": ("IMG_0001.jpg", plaintext),
            "asset-2": ("IMG_0002.jpg", Data("second photo".utf8)),
        ])
        let store = RecordingStore()
        let (engine, journal) = try tempEngine(store: store)

        let failures = try await engine.run(source: PhotoDepositSource(
            resolver: resolver, assetIds: ["asset-1", "asset-2"], destDir: "Photos/Trip"))

        #expect(failures.isEmpty)
        let rows = try journal.listFiles()
        #expect(rows.allSatisfy { $0.status == .archived })                       // both archived end-to-end
        #expect(Set(rows.map(\.id)) == ["asset-1", "asset-2"])                    // keyed by asset identity
        #expect(Set(rows.map(\.relativePath)) == ["Photos/Trip/IMG_0001.jpg", "Photos/Trip/IMG_0002.jpg"])
        #expect(rows.allSatisfy { $0.blobId != nil })

        // The photo's plaintext was genuinely encrypted before upload — its marker must NOT appear on the wire.
        #expect(!store.uploaded.isEmpty)
        #expect(store.uploaded.range(of: plaintext) == nil)
    }

    /// Re-depositing the SAME asset (even to a different folder) dedups on identity — `upsert`'s key is the
    /// id (the asset's localIdentifier), not the display path, so a second pick doesn't duplicate the row.
    @Test func reDepositingSameAssetDedupsOnIdentity() async throws {
        let resolver = FakeResolver(library: ["asset-1": ("IMG_0001.jpg", Data("a".utf8))])
        let store = RecordingStore()
        let (engine, journal) = try tempEngine(store: store)

        try await engine.run(source: PhotoDepositSource(resolver: resolver, assetIds: ["asset-1"], destDir: "A"))
        try await engine.run(source: PhotoDepositSource(resolver: resolver, assetIds: ["asset-1"], destDir: "B"))

        let rows = try journal.listFiles()
        #expect(rows.count == 1)              // one asset, one row — no duplicate from the second deposit
        #expect(rows.first?.id == "asset-1")
    }
}
