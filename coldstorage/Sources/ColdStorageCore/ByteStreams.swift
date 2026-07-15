import Foundation

/// **The two ways to hand plaintext to the upload engine, and the trap they both exist to avoid.**
///
/// `IngestItem.open()` yields an `AsyncThrowingStream<Data, Error>`, and the obvious way to build one —
/// `AsyncThrowingStream { cont in while … cont.yield(chunk) }` — is a memory bomb that does not look like
/// one. That initializer runs its closure **synchronously at construction**; the default buffering policy
/// is **`.unbounded`**; and `Continuation.yield` never suspends. So the producer runs flat out and the
/// entire file lands in the stream's buffer before the consumer asks for byte one. Measured: a 256 MiB file
/// cost 391 MiB of RSS on `open()` alone. That is what killed a 1k-file deposit on 2026-07-14 — the daemon
/// spiked by the size of each large file, and macOS started killing things.
///
/// **Never reach for `bufferingPolicy:` to fix that.** Every bounded policy DROPS elements. Dropping file
/// bytes is silent corruption, not throttling.
///
/// Which of these to use depends on whether the source will let us pull, or insists on pushing:
///   - `pullStream(of:)` — for a source we can read on demand (a file). Zero buffering, zero disk.
///   - `scratchFileStream(at:write:)` — for a source that PUSHES at its own pace (PhotoKit).

/// Bytes read on demand — one chunk per request, so the producer can never outrun the encryptor.
/// Memory tracks the chunk (1 MiB), never the file.
func pullStream(of url: URL) -> AsyncThrowingStream<Data, Error> {
    do {
        let reader = try ChunkReader(url)
        return AsyncThrowingStream(unfolding: { try reader.next() })
    } catch {
        // e.g. the file vanished between the scan and the archive — the blob fails, the run continues.
        return AsyncThrowingStream { $0.finish(throwing: error) }
    }
}

/// Bytes from a producer that will only hand them over at ITS pace (a system callback that pushes data
/// whether we are ready or not): let it write to a scratch file at full speed, then pull that file back at
/// the consumer's pace. `write` runs once, lazily, on the first demand; the scratch file is deleted when the
/// stream ends, throws, or is dropped.
///
/// **Why a scratch file instead of throttling the producer.** We could block PhotoKit's delivery thread
/// until we drain — but PhotoKit may be downloading from iCloud, and throttling it to the speed of a
/// multi-hour S3 upload means holding an iCloud download session open for those hours. Draining it at full
/// speed and releasing it is the robust trade: it DECOUPLES reading the source from uploading to the
/// network, which is the one thing the engine's staging step was genuinely buying us.
///
/// The cost is honest and bounded: one plaintext copy of the asset, transient, in the per-user scratch dir
/// (`UserSession.scratchDir` — per-user precisely because these are plaintext bytes), swept when a session is built.
public func scratchFileStream(at scratch: URL,
                              write: @escaping @Sendable (URL) async throws -> Void) -> AsyncThrowingStream<Data, Error> {
    let reader = ScratchReader(scratch: scratch, write: write)
    return AsyncThrowingStream(unfolding: { try await reader.next() })
}

/// Empty the per-user scratch dir. Called when a session is built — i.e. before that user can have any
/// deposit in flight, so it can never race a live one, and a second user signing in mid-upload sweeps their
/// own dir, not the busy one.
///
/// What ends up in here is a plaintext asset PhotoKit was pushing when the daemon died. `scratchFileStream`
/// deletes its file on EOF, on a throw, and on a dropped stream — but a SIGKILL or a dead machine skips all
/// three, and nothing else ever looks in here. Left alone, a killed photo deposit strands a full-size
/// plaintext copy of someone's video on their disk, permanently.
///
/// Deleting is always safe: nothing in here is ever read back across a restart. A resumed blob re-encrypts
/// from the source, and a resumed photo re-materializes from PhotoKit.
func sweepScratch(_ dir: URL) {
    let fm = FileManager.default
    guard let leftovers = try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.fileSizeKey]),
          !leftovers.isEmpty else { return }   // the healthy case: nothing left behind, nothing to say
    var bytes = 0
    for file in leftovers {
        bytes += (try? file.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0
        try? fm.removeItem(at: file)
    }
    // Loud on purpose: this only fires after a deposit was killed, which is exactly when someone is trying to
    // work out where their disk went.
    let mib = String(format: "%.1f", Double(bytes) / 1_048_576)
    let names = leftovers.map(\.lastPathComponent).joined(separator: ", ")
    FileHandle.standardError.write(Data("""
        UserSession: swept \(leftovers.count) orphaned scratch file(s), reclaimed \(mib) MiB \
        (a previous deposit was killed mid-asset; these bytes are never reusable): \(names)

        """.utf8))
}

/// Reads a file one chunk per `next()`. Exists to give an `unfolding` closure somewhere to keep its
/// `FileHandle` between demands.
///
/// `@unchecked Sendable` is sound here and nowhere else: `AsyncThrowingStream(unfolding:)` invokes its
/// closure **serially** — it awaits each call before issuing the next — so the handle is never touched
/// concurrently, even though successive calls may land on different threads of the cooperative pool.
final class ChunkReader: @unchecked Sendable {
    static let chunkSize = 1 << 20

    private let handle: FileHandle
    private var closed = false

    init(_ url: URL) throws { handle = try FileHandle(forReadingFrom: url) }
    /// Closes on a dropped stream too — a cancelled upload must not leak the descriptor.
    deinit { close() }

    /// One chunk, or `nil` at EOF. A throw ends the stream too, so close on both paths.
    ///
    /// The `autoreleasepool` is the same load-bearing one as in `LocalDirSource.sha256Hex` — on macOS,
    /// `FileHandle.read(upToCount:)` returns autoreleased Objective-C buffers, and a read loop without a pool
    /// accumulates every one of them. It is a no-op on Linux, so the Core's memory tests cannot see its
    /// absence; the daemon's own RSS log is what caught it.
    func next() throws -> Data? {
        do {
            let chunk = try autoreleasepool { try handle.read(upToCount: Self.chunkSize) }
            guard let chunk, !chunk.isEmpty else { close(); return nil }
            return chunk
        } catch { close(); throw error }
    }

    func close() {
        guard !closed else { return }   // close() throws if called twice
        closed = true
        try? handle.close()
    }
}

/// Materialize-then-pull, with the scratch file cleaned up on every exit path. Same serial-invocation
/// contract as `ChunkReader` — see there for why `@unchecked Sendable` holds.
private final class ScratchReader: @unchecked Sendable {
    private let scratch: URL
    private let write: @Sendable (URL) async throws -> Void
    private var reader: ChunkReader?
    private var finished = false

    init(scratch: URL, write: @escaping @Sendable (URL) async throws -> Void) {
        self.scratch = scratch; self.write = write
    }
    /// A dropped stream (a cancelled deposit) must not strand a plaintext copy on disk.
    deinit { cleanup() }

    func next() async throws -> Data? {
        if finished { return nil }
        if reader == nil {
            do {
                try? FileManager.default.removeItem(at: scratch)   // a stale scratch would make the producer fail or append
                try await write(scratch)                           // the producer runs to completion, at its own pace, into the file
                reader = try ChunkReader(scratch)
            } catch { cleanup(); throw error }
        }
        do {
            guard let chunk = try reader?.next() else { cleanup(); return nil }
            return chunk
        } catch { cleanup(); throw error }
    }

    private func cleanup() {
        guard !finished else { return }
        finished = true
        reader?.close(); reader = nil
        try? FileManager.default.removeItem(at: scratch)
    }
}

