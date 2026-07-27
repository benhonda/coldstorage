import Testing
import Foundation
import Crypto
@testable import ColdStorageCore

/// **The restore path's streaming contract: memory holds a frame, the destination holds only verified
/// bytes, and progress tells the truth.**
///
/// `RoundTripTests` proves the bytes come back identical — it cannot see HOW. A restore that buffers the
/// whole file in RAM, or writes unverified bytes straight to the destination, produces byte-identical
/// output on the happy path and passes every functional assertion while doing it. These pin the three
/// properties the streaming rewrite exists to provide, each of which is invisible to a black-box check:
///
///   1. RSS during a large restore is bounded by the frame/chunk window, not the file (the download-side
///      twin of `archivingALargeFileHoldsTheInFlightPartsInMemoryNotTheBlob`);
///   2. a failed download — including a hash mismatch discovered only at the END — leaves nothing on disk:
///      no destination file, no stranded `.coldstorage-partial`;
///   3. `onProgress` reports monotonically increasing plaintext bytes that finish exactly at the file's
///      size — the figure the Transfers page divides by `RestoreRow.bytes`.
@Suite struct RestoreStreamingTests {

    /// Archive `bytes` through the real UploadEngine into a FakeVault, hand back the restore fixture.
    /// A REAL round trip on purpose: hand-journaled rows would decouple these tests from the offset/frame
    /// arithmetic the streaming decrypt has to get right. `wrap` lets a test interpose on the vault the
    /// RESTORE reads from (e.g. to truncate the stream) while the archive still lands in the real fake.
    private func archived(_ bytes: Data, wrap: (FakeVault) -> any VaultStore = { $0 }) async throws
        -> (restore: RestoreEngine, journal: Journal, base: URL, fileId: String) {
        let fm = FileManager.default
        let base = fm.temporaryDirectory.appendingPathComponent("cs-rstream-\(UUID().uuidString)")
        let root = base.appendingPathComponent("data")
        try fm.createDirectory(at: root, withIntermediateDirectories: true)
        try bytes.write(to: root.appendingPathComponent("file.bin"))

        let journal = try Journal(path: base.appendingPathComponent("j.sqlite").path)
        let keys = LocalFileKEK(path: base.appendingPathComponent("kek.bin").path)
        let vault = FakeVault()
        let failures = try await UploadEngine(journal: journal, store: vault, keys: keys)
            .run(source: LocalDirSource(root: root), prefix: .dev)
        try #require(failures.isEmpty)
        return (RestoreEngine(journal: journal, store: wrap(vault), keys: keys, canSelfThaw: true),
                journal, base, "file.bin")
    }

    // MARK: - 1. the memory bound

    /// **The headline claim, pinned to a number.** Restoring a file must cost roughly the streaming window
    /// (one sealed frame + one network chunk + the frame being decrypted), NOT the file — the old
    /// implementation held ciphertext AND plaintext whole, ~2× the file resident.
    ///
    /// The fixture keeps the assembled object in the fake (there is nowhere else to serve ranged reads
    /// from), so the baseline is taken AFTER archiving: the object is steady-state by then, and the delta
    /// measures the restore alone.
    @Test(.measuresProcessMemory) func restoringALargeFileHoldsFramesInMemoryNotTheFile() async throws {
        let fm = FileManager.default
        // 256 MiB — 64 frames. The old implementation's ~2× buffering (≈512 MiB) is unmissable against a
        // bound set at a fraction of the file.
        var big = Data(capacity: 256 << 20)
        let mib = Data(repeating: 0x5A, count: 1 << 20)
        for _ in 0..<256 { big.append(mib) }
        let f = try await archived(big)
        defer { try? fm.removeItem(at: f.base) }
        big = Data()   // the fixture's own copy must not sit inside the measurement window

        let dest = f.base.appendingPathComponent("out/file.bin")
        let before = ProcessMemory.residentBytes()
        let outcome = try await f.restore.restore(fileId: f.fileId, to: dest)
        let peak = ProcessMemory.residentBytes() - before

        #expect(outcome == .restored)
        #expect(try Data(contentsOf: dest).count == 256 << 20)
        // Bound = pending buffer (≤ frame + chunk) + the plaintext frame + transient per-chunk copies.
        // 96 MiB is generous headroom for that and still under the file by more than half — and under the
        // old implementation's footprint by ~5×.
        #expect(peak < 96 << 20,
                "restoring a 256 MiB file grew RSS by \(peak >> 20) MiB — it isn't streaming frame-by-frame")
    }

    // MARK: - 2. only verified bytes reach the destination

    /// A download that dies mid-stream (here: the object's bytes fail frame auth — same failure path as a
    /// dropped connection or a bad range) must leave the destination untouched and no partial stranded.
    /// The write now happens BEFORE the verify, so this is the property that keeps that reordering honest.
    @Test func aFailedDownloadLeavesNoFileAndNoPartial() async throws {
        let fm = FileManager.default
        let payload = Data(repeating: 0xC3, count: EnvelopeCipher.frameSize + 4096)   // two frames
        let f = try await archived(payload)
        defer { try? fm.removeItem(at: f.base) }

        // Corrupt the recorded hash so the download itself succeeds and the FINAL verify fails — the
        // latest possible failure, after every byte is already on disk in the partial. Re-archiving the
        // same mapping with a wrong hash is the API-shaped way to plant journal corruption.
        let m = try #require(try f.journal.fileMapping(f.fileId))
        try f.journal.markFileArchived(f.fileId, blobId: m.blobId, offset: m.offset, length: m.length,
                                       firstFrame: m.firstFrame, plaintextSha256: "not-the-hash",
                                       size: payload.count)

        let dest = f.base.appendingPathComponent("out/file.bin")
        await #expect(throws: ColdStorageError.self) {
            try await f.restore.restore(fileId: f.fileId, to: dest)
        }

        #expect(!fm.fileExists(atPath: dest.path),
                "unverified bytes reached the destination")
        #expect(!fm.fileExists(atPath: dest.appendingPathExtension("coldstorage-partial").path),
                "a failed download stranded its partial file")
    }

    /// A stream that ends EARLY — the wire shape of a cut connection — must fail as `.shortRead`, the one
    /// fault that classifies TRANSIENT so the next pass retries. Before the case existed this surfaced as
    /// a hash mismatch (or, truncated on a frame boundary, as `.integrity`) — both PERMANENT, so one
    /// dropped connection stranded a paid transfer for good. And, as everywhere: nothing left on disk.
    @Test func aTruncatedStreamFailsTransientAndLeavesNothing() async throws {
        /// Forwards to the real fake but cuts the ranged read off before the end. Only the read is
        /// interesting; the rest of `VaultStore` passes straight through.
        final class TruncatingVault: VaultStore, @unchecked Sendable {
            let inner: FakeVault
            init(_ inner: FakeVault) { self.inner = inner }
            func thawState(key: String) async throws -> ThawState { try await inner.thawState(key: key) }
            func requestThaw(key: String, days: Int, tier: RestoreTier) async throws {}
            func usageBytes(prefix: VaultPrefix) async throws -> Int { try await inner.usageBytes(prefix: prefix) }
            func getRange(key: String, offset: Int, length: Int) async throws -> AsyncThrowingStream<Data, Error> {
                // Serve the span minus its final byte — a truncation the frame walk alone can't detect
                // until the last frame fails to authenticate, which is exactly the confusing failure the
                // explicit received-vs-span check preempts.
                try await inner.getRange(key: key, offset: offset, length: length - 1)
            }
        }

        let fm = FileManager.default
        let f = try await archived(Data(repeating: 0x11, count: 300_000), wrap: { TruncatingVault($0) })
        defer { try? fm.removeItem(at: f.base) }

        let dest = f.base.appendingPathComponent("out/file.bin")
        do {
            _ = try await f.restore.restore(fileId: f.fileId, to: dest)
            Issue.record("a truncated stream must not restore successfully")
        } catch {
            #expect(!FailureKind.classify(error).isPermanent,
                    "a cut connection must classify transient (got: \(error)) — permanent strands a paid transfer")
        }
        #expect(!fm.fileExists(atPath: dest.path))
        #expect(!fm.fileExists(atPath: dest.appendingPathExtension("coldstorage-partial").path))
    }

    /// Re-restoring over an existing file (the pre-streaming behavior: silent overwrite) still works — the
    /// rename lands on an occupied destination.
    @Test func restoringOverAnExistingFileReplacesIt() async throws {
        let fm = FileManager.default
        let payload = Data("the real content".utf8)
        let f = try await archived(payload)
        defer { try? fm.removeItem(at: f.base) }

        let dest = f.base.appendingPathComponent("out/file.bin")
        try fm.createDirectory(at: dest.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("stale bytes from an earlier restore".utf8).write(to: dest)

        _ = try await f.restore.restore(fileId: f.fileId, to: dest)
        #expect(try Data(contentsOf: dest) == payload)
    }

    // MARK: - 3. progress tells the truth

    /// `onProgress` must count plaintext bytes, strictly forward, finishing exactly at the file's size —
    /// that final value is what lets the Transfers page's bar reach 100% against `RestoreRow.bytes`, and a
    /// ciphertext count here would finish ~4 ppm high on every multi-frame file.
    @Test func progressTicksArePlaintextMonotonicAndFinishAtTheFileSize() async throws {
        let fm = FileManager.default
        // Three frames, the last one short — so the final short-frame path contributes a tick too.
        let size = EnvelopeCipher.frameSize * 2 + 7777
        let f = try await archived(Data(repeating: 0x7E, count: size))
        defer { try? fm.removeItem(at: f.base) }

        // Collected under a lock: the callback is @Sendable and (by the engine's serial loop) invoked in
        // order, but the compiler can't see that — the lock keeps the test warning-free without an actor hop.
        final class Ticks: @unchecked Sendable {
            private let lock = NSLock()
            private var _values: [Int] = []
            func append(_ v: Int) { lock.withLock { _values.append(v) } }
            var values: [Int] { lock.withLock { _values } }
        }
        let ticks = Ticks()

        _ = try await f.restore.restore(fileId: f.fileId, to: f.base.appendingPathComponent("out/file.bin"),
                                        onProgress: { ticks.append($0) })

        let seen = ticks.values
        #expect(seen.count == 3, "three frames should tick three times, got \(seen.count)")
        #expect(seen == seen.sorted() && Set(seen).count == seen.count, "progress must strictly increase")
        #expect(seen.last == size, "the last tick must land exactly on the plaintext size")
    }

    /// A zero-byte restore emits no progress ticks — there are no bytes to narrate, and a `0 of 0` tick
    /// would divide by zero somewhere it matters.
    @Test func aZeroByteRestoreEmitsNoProgress() async throws {
        let fm = FileManager.default
        let base = fm.temporaryDirectory.appendingPathComponent("cs-rstream-\(UUID().uuidString)")
        let root = base.appendingPathComponent("data")
        try fm.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: base) }
        try Data().write(to: root.appendingPathComponent("empty.bin"))
        // A zero-byte file uploads no parts, so `retainParts` is irrelevant — but the neighbour file gives
        // the blob real bytes, keeping the fixture honest about batched spans.
        try Data("neighbour".utf8).write(to: root.appendingPathComponent("beside.bin"))

        let journal = try Journal(path: base.appendingPathComponent("j.sqlite").path)
        let keys = LocalFileKEK(path: base.appendingPathComponent("kek.bin").path)
        let vault = FakeVault()
        try #require(try await UploadEngine(journal: journal, store: vault, keys: keys)
            .run(source: LocalDirSource(root: root), prefix: .dev).isEmpty)

        final class Flag: @unchecked Sendable {
            private let lock = NSLock(); private var _ticked = false
            func set() { lock.withLock { _ticked = true } }
            var ticked: Bool { lock.withLock { _ticked } }
        }
        let flag = Flag()
        let restore = RestoreEngine(journal: journal, store: vault, keys: keys, canSelfThaw: true)
        _ = try await restore.restore(fileId: "empty.bin", to: base.appendingPathComponent("out/empty.bin"),
                                      onProgress: { _ in flag.set() })
        #expect(!flag.ticked)
        #expect(try Data(contentsOf: base.appendingPathComponent("out/empty.bin")).isEmpty)
    }
}
