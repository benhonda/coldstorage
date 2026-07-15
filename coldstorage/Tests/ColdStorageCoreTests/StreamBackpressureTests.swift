import Testing
import Foundation
@testable import ColdStorageCore

/// Resident memory of THIS process, right now — the SSOT lives in `ProcessMemory` (the daemon logs from the
/// same routine), so tests read it rather than each carrying a `mach_task_basic_info` copy.
private func currentRSSBytes() -> Int { ProcessMemory.residentBytes() }

/// **A byte stream must cost bytes, not files.**
///
/// The upload path reads plaintext through `IngestItem.open()`. If that stream has no backpressure, the
/// producer races ahead of the encryptor and the whole file lands in RAM — so archiving a 4 GB video costs
/// 4 GB of resident memory in the daemon, on a machine whose RAM the user is also using. That is a crash,
/// not a slowdown, and it scales with the user's biggest file, which for a photo/video backup product is
/// exactly the file they care most about.
///
/// This test pins the invariant to a NUMBER, because the bug is invisible to every functional test: the
/// bytes are all correct, there are just far too many of them in memory at once.
@Suite struct StreamBackpressureTests {
    static let fileSize = 256 << 20   // big enough that buffering it is unmistakable against noise
    static let ceiling  = 32 << 20    // a chunk or two in flight is fine; a whole file is not

    private func makeBigFile() throws -> (url: URL, base: URL) {
        let fm = FileManager.default
        let base = fm.temporaryDirectory.appendingPathComponent("cs-bp-\(UUID().uuidString)")
        try fm.createDirectory(at: base, withIntermediateDirectories: true)
        let url = base.appendingPathComponent("big.bin")
        // Write in 1 MiB chunks so the WRITER never holds the file in memory and pollutes the measurement.
        _ = fm.createFile(atPath: url.path, contents: nil)
        let fh = try FileHandle(forWritingTo: url)
        let chunk = Data(repeating: 0x5A, count: 1 << 20)
        for _ in 0..<(Self.fileSize >> 20) { try fh.write(contentsOf: chunk) }
        try fh.close()
        return (url, base)
    }

    /// Merely OPENING the stream must not read the file. `AsyncThrowingStream { cont in … }` runs its
    /// producer closure synchronously at construction and buffers every `yield` (default policy:
    /// `.unbounded`, and `yield` never suspends) — so a push-producer drains the entire file into the
    /// stream's buffer before the consumer asks for byte one.
    @Test func openingAStreamDoesNotReadTheFileIntoMemory() throws {
        let f = try makeBigFile()
        defer { try? FileManager.default.removeItem(at: f.base) }

        let before = currentRSSBytes()
        let stream = LocalDirSource.stream(f.url)   // deliberately NOT consumed
        let after = currentRSSBytes()
        withExtendedLifetime(stream) {}             // keep the buffer alive across the measurement

        #expect(after - before < Self.ceiling,
                "opening a \(Self.fileSize >> 20) MiB file's stream grew RSS by \((after - before) >> 20) MiB — it buffered the file instead of streaming it")
    }

    /// And consuming it must stay flat: the encryptor pulls 4 MiB frames, so RAM should track the chunk in
    /// flight, never the file. Guards the case where a producer is lazy but still races ahead of the reader.
    @Test func consumingAStreamStaysFlat() async throws {
        let f = try makeBigFile()
        defer { try? FileManager.default.removeItem(at: f.base) }

        let before = currentRSSBytes()
        var peak = 0, bytes = 0
        for try await chunk in LocalDirSource.stream(f.url) {
            bytes += chunk.count
            peak = max(peak, currentRSSBytes() - before)
        }

        #expect(bytes == Self.fileSize)             // it really did stream the whole file…
        #expect(peak < Self.ceiling,               // …without ever holding it
                "streaming a \(Self.fileSize >> 20) MiB file peaked at \(peak >> 20) MiB of RSS")
    }

    /// The PhotoKit shape. PhotoKit PUSHES bytes at us (no way to ask it to wait), so `scratchFileStream`
    /// lets it drain to a file at full speed and pulls that file back at the encryptor's pace. The invariant
    /// is the same — memory tracks the chunk, not the asset — and the plaintext copy must not outlive the
    /// stream. `write` here stands in for `PHAssetResourceManager.writeData`.
    @Test func scratchFileStreamStaysFlatAndCleansUp() async throws {
        let fm = FileManager.default
        let base = fm.temporaryDirectory.appendingPathComponent("cs-scratch-\(UUID().uuidString)")
        try fm.createDirectory(at: base, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: base) }
        let scratch = base.appendingPathComponent("photo-asset-1")

        let before = currentRSSBytes()
        var peak = 0, bytes = 0
        let stream = scratchFileStream(at: scratch) { url in
            // A push producer, writing at ITS pace into the file we handed it.
            _ = fm.createFile(atPath: url.path, contents: nil)
            let fh = try FileHandle(forWritingTo: url)
            let chunk = Data(repeating: 0x7E, count: 1 << 20)
            for _ in 0..<(Self.fileSize >> 20) { try fh.write(contentsOf: chunk) }
            try fh.close()
        }
        for try await chunk in stream {
            bytes += chunk.count
            peak = max(peak, currentRSSBytes() - before)
        }

        #expect(bytes == Self.fileSize)
        #expect(peak < Self.ceiling,
                "a \(Self.fileSize >> 20) MiB pushed asset peaked at \(peak >> 20) MiB of RSS")
        #expect(fm.fileExists(atPath: scratch.path) == false)   // the plaintext copy is gone at EOF
    }

    /// A failed asset (a stale pick, a dead iCloud download) must not strand a plaintext copy on disk.
    @Test func scratchFileStreamCleansUpWhenTheProducerFails() async throws {
        struct Boom: Error {}
        let fm = FileManager.default
        let base = fm.temporaryDirectory.appendingPathComponent("cs-scratch-\(UUID().uuidString)")
        try fm.createDirectory(at: base, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: base) }
        let scratch = base.appendingPathComponent("photo-asset-2")

        let stream = scratchFileStream(at: scratch) { url in
            try Data(repeating: 0x11, count: 4096).write(to: url)   // a partial write…
            throw Boom()                                            // …then the download dies
        }

        await #expect(throws: Boom.self) {
            for try await _ in stream {}
        }
        #expect(fm.fileExists(atPath: scratch.path) == false)
    }
}
