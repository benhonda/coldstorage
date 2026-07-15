import Testing
import Foundation
@testable import ColdStorageCore

/// The engine encrypts straight into the multipart upload — no staging file, nothing on disk. These pin the
/// three claims that change makes, because each one is invisible to the other tests:
///
///   1. RESUME still works, and still doesn't re-send bytes S3 already holds. Staging used to be justified as
///      "what makes resume possible"; it wasn't (a resumed blob always re-read and re-encrypted from source),
///      but that's only a safe thing to say if resume is actually pinned. So: pin it.
///   2. A source that CHANGED between the scan and the upload is caught. Without the guard, the engine
///      happily archives bytes the plan was never made from — and every downstream check still passes
///      (`verify` is a HEAD), so it surfaces at RESTORE. Silent corruption is the failure mode this product
///      cannot have.
///   3. The per-user scratch dir is emptied when a session is built, so a killed photo deposit can't strand a
///      full-size plaintext copy of someone's video forever.
@Suite struct StreamingUploadTests {


    private struct Fixture {
        let engine: UploadEngine, journal: Journal, keys: LocalFileKEK
        let store: FakeVault, source: LocalDirSource, root: URL, base: URL
    }

    private func fixture(fileBytes: Data = Data("hello streaming world".utf8),
                         alreadyOnS3: Set<Int> = []) throws -> Fixture {
        let fm = FileManager.default
        let base = fm.temporaryDirectory.appendingPathComponent("cs-stream-\(UUID().uuidString)")
        let root = base.appendingPathComponent("data")
        try fm.createDirectory(at: root, withIntermediateDirectories: true)
        try fileBytes.write(to: root.appendingPathComponent("f.bin"))
        let journal = try Journal(path: base.appendingPathComponent("j.sqlite").path)
        let keys = LocalFileKEK(path: base.appendingPathComponent("kek.bin").path)
        let store = FakeVault(alreadyOnS3: alreadyOnS3)
        return Fixture(engine: UploadEngine(journal: journal, store: store, keys: keys),
                       journal: journal, keys: keys, store: store,
                       source: LocalDirSource(root: root), root: root, base: base)
    }

    /// The happy path, end to end, with nothing written to disk along the way.
    @Test func archivesByStreamingStraightIntoTheUpload() async throws {
        let f = try fixture()
        defer { try? FileManager.default.removeItem(at: f.base) }

        let items = try await f.source.enumerate()
        let failures = try await f.engine.run(source: f.source, prefix: .dev)

        #expect(failures.isEmpty)
        #expect(try f.journal.isFileArchived(items[0].id) == true)
        #expect(f.store.completedKeys.count == 1)
        #expect(f.store.uploadedPartNumbers == [1])            // one small blob → one final part
        #expect(f.store.uploaded.count == EnvelopeCipher.encryptedSize(ofPlaintext: items[0].size))
    }

    /// The size the progress bar's denominator is derived from has to be exactly right, or a large upload
    /// reports a percentage that never reaches 100. Staging used to measure it; now we predict it, so the
    /// prediction is worth pinning against the real cipher rather than trusting the arithmetic.
    @Test func predictedEncryptedSizeMatchesWhatIsActuallyProduced() async throws {
        // Spans several frames + a partial one, so the per-frame tag overhead can't cancel out by luck.
        let plaintext = Data(repeating: 0x42, count: EnvelopeCipher.frameSize * 2 + 1234)
        let f = try fixture(fileBytes: plaintext)
        defer { try? FileManager.default.removeItem(at: f.base) }

        _ = try await f.engine.run(source: f.source, prefix: .dev)

        #expect(f.store.uploaded.count == EnvelopeCipher.encryptedSize(ofPlaintext: plaintext.count))
    }

    /// RESUME. A killed run left an open multipart upload with part 1 already on S3. The re-run must reuse
    /// that upload (not start a second one) and must NOT re-send part 1 — while still producing a complete,
    /// correct object, because the parts it skips are exactly the bytes S3 already has.
    @Test func resumeReusesTheOpenUploadAndSkipsPartsAlreadyOnS3() async throws {
        // Big enough to be a genuine multi-part upload, so "skipped part 1" means something.
        let plaintext = Data(repeating: 0x37, count: S3Store.partSize + (8 << 20))
        let f = try fixture(fileBytes: plaintext, alreadyOnS3: [1])   // part 1 landed before the kill
        defer { try? FileManager.default.removeItem(at: f.base) }

        // The state a killed run leaves: blob planned, crypto stored, multipart open, part 1 landed.
        let items = try await f.source.enumerate()
        try f.journal.upsert(items)
        let blob = BlobPlanner().plan(items, prefix: .dev)[0]
        let cipher = EnvelopeCipher()
        try f.journal.ensureBlob(blob, noncePrefix: cipher.randomPrefix(),
                                 wrappedDEK: try cipher.wrap(cipher.newDEK(), kek: f.keys.userKEK()))
        try f.journal.setUploadId(blob.id, "u-already-open-on-s3")
        try f.journal.recordPart(PartRow(blobId: blob.id, partNumber: 1, eTag: "etag-1", sha256: "sha-1", status: .uploaded))

        let failures = try await f.engine.run(source: f.source, prefix: .dev)

        #expect(failures.isEmpty)
        #expect(f.store.createdKeys.isEmpty)                   // reused the open upload — no second multipart
        #expect(f.store.uploadedPartNumbers == [2])            // part 1 was GENERATED but not re-sent
        #expect(f.store.completedKeys.count == 1)
        #expect(try f.journal.isFileArchived(items[0].id) == true)
    }

    /// **RESUME WHERE S3 AND THE JOURNAL DISAGREE.** `uploadPart` returns for part 1, then the process dies
    /// before the journal row commits — a window that exists once per part. On the re-run, `ListParts` says
    /// part 1 is on S3, but the journal has never heard of it.
    ///
    /// Skipping on S3's word alone was silent data loss: `complete` is fed from the JOURNAL, and
    /// `CompleteMultipartUpload` assembles only the parts it is handed — so the object came back 64 MiB short
    /// with every later byte shifted, `verify` (a HEAD) saw nothing wrong, and the file was marked archived.
    /// It surfaced at restore, if ever. The part must be re-uploaded so the journal learns about it.
    @Test func resumeReUploadsAPartThatS3HasButTheJournalDoesNot() async throws {
        let plaintext = Data(repeating: 0x37, count: S3Store.partSize + (8 << 20))
        let f = try fixture(fileBytes: plaintext, alreadyOnS3: [1])   // S3 says part 1 landed…
        defer { try? FileManager.default.removeItem(at: f.base) }

        let items = try await f.source.enumerate()
        try f.journal.upsert(items)
        let blob = BlobPlanner().plan(items, prefix: .dev)[0]
        let cipher = EnvelopeCipher()
        try f.journal.ensureBlob(blob, noncePrefix: cipher.randomPrefix(),
                                 wrappedDEK: try cipher.wrap(cipher.newDEK(), kek: f.keys.userKEK()))
        try f.journal.setUploadId(blob.id, "u-already-open-on-s3")
        // …and the journal does NOT: the recordPart never committed. (Contrast the test above, which records it.)

        let failures = try await f.engine.run(source: f.source, prefix: .dev)

        #expect(failures.isEmpty)
        #expect(f.store.uploadedPartNumbers == [1, 2])   // part 1 re-sent, so `complete` can name it
        #expect(try f.journal.completedParts(blob.id).map(\.partNumber).sorted() == [1, 2])
        #expect(try f.journal.isFileArchived(items[0].id) == true)
    }

    /// THE DRIFT GUARD. The file changes between the scan that planned the blob and the read that uploads it.
    /// Nothing downstream would notice: the journal would record a SHA of whatever we read, `verify` is only a
    /// HEAD, and the file would be marked archived — with the corruption surfacing at restore. It must fail
    /// the blob instead, and must NOT mark the file archived.
    @Test func aSourceThatChangedSinceTheScanFailsInsteadOfArchivingSilently() async throws {
        let f = try fixture(fileBytes: Data("the bytes the plan was made from".utf8))
        defer { try? FileManager.default.removeItem(at: f.base) }

        // Scan first (this is what fixes the item's `.sha256` content key), THEN change the file underneath.
        let items = try await f.source.enumerate()
        let drifted = DriftingSource(items: items, root: f.root)

        let failures = try await f.engine.run(source: drifted, prefix: .dev)

        #expect(failures.count == 1)
        #expect(failures[0].kind.isPermanent)                            // this blob id can never be archived again…
        #expect(failures[0].files.map(\.path) == ["f.bin"])
        #expect(try f.journal.isFileArchived(items[0].id) == false)      // …and the file is NOT claimed as backed up
        #expect(f.store.completedKeys.isEmpty)                              // the torn object was never completed
    }

    /// Hands back items the scan produced, but rewrites the file on disk first — so `open()` streams bytes
    /// that no longer match the `.sha256` content key the plan carries. Exactly the race where a user saves over a
    /// file while it's being uploaded.
    struct DriftingSource: IngestSource {
        let items: [IngestItem]
        let root: URL
        func enumerate() async throws -> [IngestItem] {
            try Data("COMPLETELY DIFFERENT BYTES, WRITTEN MID-UPLOAD".utf8)
                .write(to: root.appendingPathComponent("f.bin"))
            return items
        }
    }

    /// A photo's content key is `.opaque` — PhotoKit only produces the bytes once it streams them, so there
    /// is no pre-read hash to check against. The guard must stay OUT of its way rather than failing every photo.
    @Test func aSourceWithNoPreReadHashIsArchivedNormally() async throws {
        let f = try fixture()
        defer { try? FileManager.default.removeItem(at: f.base) }

        let bytes = Data("pushed bytes, hashed only as they arrive".utf8)
        let photo = IngestItem(id: "photo-1", relativePath: "IMG_0001.HEIC", size: bytes.count,
                               // `.opaque` = an identity, not a hash — so there is nothing to check the
                               // streamed bytes against, and the type is what says so.
                               content: .opaque("some-asset-id"),
                               createdAt: nil, isFavorite: false,
                               open: { AsyncThrowingStream { c in c.yield(bytes); c.finish() } })

        let failures = try await f.engine.run(source: StaticSource(items: [photo]), prefix: .dev)

        #expect(failures.isEmpty)
        #expect(try f.journal.isFileArchived("photo-1") == true)
    }

    struct StaticSource: IngestSource {
        let items: [IngestItem]
        func enumerate() async throws -> [IngestItem] { items }
    }

    /// **The headline claim, pinned to a number: memory holds the parts in flight, not the blob.**
    ///
    /// No functional test can see this — a blob buffered entirely in RAM produces byte-identical output to one
    /// shipped part by part. So measure it: archiving a file must cost roughly the concurrency window (a few
    /// 64 MiB parts), NOT the file size. The bound is `maxInFlight` parts, not one — uploads now run in
    /// parallel — but it is still a small constant, wildly under the blob.
    @Test func archivingALargeFileHoldsTheInFlightPartsInMemoryNotTheBlob() async throws {
        let fm = FileManager.default
        let base = fm.temporaryDirectory.appendingPathComponent("cs-mem-\(UUID().uuidString)")
        let root = base.appendingPathComponent("data")
        try fm.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: base) }

        // 768 MiB — twelve parts. If the engine held the blob, or failed to bound concurrency, this is unmissable.
        let big = root.appendingPathComponent("big.bin")
        _ = fm.createFile(atPath: big.path, contents: nil)
        let fh = try FileHandle(forWritingTo: big)
        let mib = Data(repeating: 0x5A, count: 1 << 20)
        for _ in 0..<768 { try fh.write(contentsOf: mib) }
        try fh.close()

        let journal = try Journal(path: base.appendingPathComponent("j.sqlite").path)
        // A store that HOLDS each part briefly, so parts genuinely overlap in flight — otherwise an instant
        // fake drains each part before the next is dispatched and the concurrency bound is never exercised.
        // retainParts: false so the fake itself doesn't accumulate the blob and swamp the measurement.
        let engine = UploadEngine(journal: journal, store: FakeVault(retainParts: false, delayMs: 15),
                                  keys: LocalFileKEK(path: base.appendingPathComponent("kek.bin").path))

        let before = ProcessMemory.residentBytes()
        _ = try await engine.run(source: LocalDirSource(root: root), prefix: .dev)
        let peak = ProcessMemory.residentBytes() - before

        // Bound = maxInFlight (4) parts + the buffer + a frame + the copies handed to the tasks ≈ 6 parts.
        // 384 MiB is generous headroom for that and still less than the 768 MiB blob by half.
        #expect(peak < 384 << 20,
                "archiving a 768 MiB file grew RSS by \(peak >> 20) MiB — it isn't bounding parts in flight")
    }

    /// The scratch dir holds a PLAINTEXT asset while PhotoKit pushes it. A SIGKILL skips every cleanup path
    /// `scratchFileStream` has, so a killed deposit would otherwise leave a full-size copy of someone's video
    /// on their disk forever. Building a session empties it.
    @Test func buildingASessionSweepsOrphanedScratchFiles() throws {
        let fm = FileManager.default
        let dir = fm.temporaryDirectory.appendingPathComponent("cs-scratch-sweep-\(UUID().uuidString)")
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: dir) }

        try Data(repeating: 0xAB, count: 4096).write(to: dir.appendingPathComponent("photo-ABC123"))
        try Data(repeating: 0xCD, count: 8192).write(to: dir.appendingPathComponent("photo-DEF456"))

        sweepScratch(dir)

        #expect(try fm.contentsOfDirectory(atPath: dir.path).isEmpty)
    }
}
