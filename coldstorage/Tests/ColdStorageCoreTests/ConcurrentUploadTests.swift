import Testing
import Foundation
@testable import ColdStorageCore

/// Parts go up in parallel now — a link with headroom is filled instead of sitting idle between one-part-at-
/// a-time round trips. These pin the two things that make that safe rather than reckless: it ACTUALLY
/// overlaps (or there's no speedup), and it never exceeds the in-flight cap (or memory is unbounded and we're
/// back to the crash). Counting, not timing — deterministic.
@Suite struct ConcurrentUploadTests {

    /// A file several parts long, uploaded through a delaying `FakeVault` (which tracks the concurrency
    /// high-water mark). More than one part must be in flight at once (proof the parallelism is real), and
    /// never more than the cap (proof memory stays bounded).
    @Test func partsUploadConcurrentlyButNeverExceedTheCap() async throws {
        let fm = FileManager.default
        let base = fm.temporaryDirectory.appendingPathComponent("cs-conc-\(UUID().uuidString)")
        let root = base.appendingPathComponent("data")
        try fm.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: base) }

        // ~6 parts of ciphertext (> the default cap of 4), so the cap is actually reached.
        let big = root.appendingPathComponent("big.bin")
        _ = fm.createFile(atPath: big.path, contents: nil)
        let fh = try FileHandle(forWritingTo: big)
        let mib = Data(repeating: 0x5A, count: 1 << 20)
        for _ in 0..<(6 * 64) { try fh.write(contentsOf: mib) }
        try fh.close()

        let probe = FakeVault(delayMs: 20)
        let journal = try Journal(path: base.appendingPathComponent("j.sqlite").path)
        let engine = UploadEngine(journal: journal, store: probe,
                                  keys: LocalFileKEK(path: base.appendingPathComponent("kek.bin").path))
        let failures = try await engine.run(source: LocalDirSource(root: root), prefix: .dev)

        #expect(failures.isEmpty)
        #expect(probe.maxConcurrentParts >= 2, "parts never overlapped — the upload is still effectively sequential")
        #expect(probe.maxConcurrentParts <= UploadTuning.maxPartsInFlight,
                "\(probe.maxConcurrentParts) parts were in flight — the memory bound is not being enforced")
    }

    /// Concurrency must not reorder or drop bytes: the assembled object still restores to the original. (The
    /// probe assembles parts by number, so this is a real end-to-end check that out-of-order completion is fine.)
    @Test func aConcurrentlyUploadedFileStillRestoresIntact() async throws {
        let fm = FileManager.default
        let base = fm.temporaryDirectory.appendingPathComponent("cs-conc-rt-\(UUID().uuidString)")
        let root = base.appendingPathComponent("data")
        let out = base.appendingPathComponent("out")
        try fm.createDirectory(at: root, withIntermediateDirectories: true)
        try fm.createDirectory(at: out, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: base) }

        // Four 64 MiB parts, each a DISTINCT byte value — built with memset (instant), not a per-byte random
        // loop (which made this test a two-minute outlier). Distinct-per-part content means a part-numbering
        // or offset bug under concurrency shows up as a mismatch after restore, which is the whole point.
        var bytes = Data()
        for p in 0..<4 { bytes.append(Data(repeating: UInt8(0x10 + p), count: 64 << 20)) }
        try bytes.write(to: root.appendingPathComponent("v.bin"))

        let probe = FakeVault(delayMs: 5)
        let journal = try Journal(path: base.appendingPathComponent("j.sqlite").path)
        let keys = LocalFileKEK(path: base.appendingPathComponent("kek.bin").path)
        _ = try await UploadEngine(journal: journal, store: probe, keys: keys)
            .run(source: LocalDirSource(root: root), prefix: .dev)

        let dest = out.appendingPathComponent("v.bin")
        _ = try await RestoreEngine(journal: journal, store: probe, keys: keys, canSelfThaw: true)
            .restore(fileId: "v.bin", to: dest)
        #expect(try Data(contentsOf: dest) == bytes)
    }
}
