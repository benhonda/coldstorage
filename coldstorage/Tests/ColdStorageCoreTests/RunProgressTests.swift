import Testing
import Foundation
@testable import ColdStorageCore

/// **A batched deposit must not be a black box.** Small files batch into few blobs, and the daemon only used
/// to signal `fileArchived` when a whole blob verified — so 1000 files were silence, then a burst of green,
/// with no bytes and no way to draw a bar or an ETA (2026-07-14). `run` now drives a `RunProgress` stream.
///
/// These pin what the UI relies on: the denominators are known up front, bytes advance monotonically to
/// exactly 100%, every file is counted, and the "now uploading" line actually names the files.
@Suite struct RunProgressTests {

    private func fixture(_ files: [String: Data]) throws -> (engine: UploadEngine, source: LocalDirSource, base: URL) {
        let fm = FileManager.default
        let base = fm.temporaryDirectory.appendingPathComponent("cs-prog-\(UUID().uuidString)")
        let root = base.appendingPathComponent("data")
        try fm.createDirectory(at: root, withIntermediateDirectories: true)
        for (name, bytes) in files { try bytes.write(to: root.appendingPathComponent(name)) }
        let journal = try Journal(path: base.appendingPathComponent("j.sqlite").path)
        let engine = UploadEngine(journal: journal, store: FakeVault(),
                                  keys: LocalFileKEK(path: base.appendingPathComponent("kek.bin").path))
        return (engine, LocalDirSource(root: root), base)
    }

    /// Collects every snapshot the run emits — an actor, because the callback is `@Sendable` and fires from
    /// the engine's isolation domain.
    actor Recorder {
        private(set) var snaps: [RunProgress] = []
        func record(_ p: RunProgress) { snaps.append(p) }
        var callback: @Sendable (RunProgress) async -> Void { { await self.record($0) } }
    }

    @Test func aBatchedDepositEmitsMonotonicByteProgressToExactly100Percent() async throws {
        // Several small files in ONE folder → one batched blob. The old code emitted zero byte-progress for
        // this; it's the exact case the user hit.
        let f = try fixture([
            "a.txt": Data(repeating: 0x41, count: 30_000),
            "b.txt": Data(repeating: 0x42, count: 50_000),
            "c.txt": Data(repeating: 0x43, count: 20_000),
        ])
        defer { try? FileManager.default.removeItem(at: f.base) }

        let rec = Recorder()
        _ = try await f.engine.run(source: f.source, prefix: .dev, onRunProgress: rec.callback)
        let snaps = await rec.snaps

        #expect(!snaps.isEmpty)
        // Denominators are known from the very first tick — that's what gives the UI a bar immediately.
        let total = try #require(snaps.first)
        #expect(total.filesTotal == 3)
        #expect(total.bytesTotal > 0)
        #expect(snaps.allSatisfy { $0.filesTotal == 3 && $0.bytesTotal == total.bytesTotal })

        // Bytes never go backwards, and files never un-count.
        for (prev, next) in zip(snaps, snaps.dropFirst()) {
            #expect(next.bytesUploaded >= prev.bytesUploaded)
            #expect(next.filesArchived >= prev.filesArchived)
        }

        // It ENDS complete: every byte shipped, every file counted, bar at exactly 100%.
        let last = try #require(snaps.last)
        #expect(last.bytesUploaded == last.bytesTotal)
        #expect(last.filesArchived == 3)
    }

    /// The "now uploading …" line must actually name the files, in order — otherwise the UI has a bar but no
    /// sense of what it's chewing through.
    @Test func theCurrentPathNamesEachFileAsItStreams() async throws {
        let f = try fixture([
            "one.txt": Data("first".utf8),
            "two.txt": Data("second".utf8),
        ])
        defer { try? FileManager.default.removeItem(at: f.base) }

        let rec = Recorder()
        _ = try await f.engine.run(source: f.source, prefix: .dev, onRunProgress: rec.callback)
        let named = await rec.snaps.compactMap(\.currentPath).filter { !$0.isEmpty }

        #expect(Set(named) == ["one.txt", "two.txt"])
    }

    /// No callback ⇒ no reporter is even built, so the hot path pays nothing when nobody's watching.
    @Test func noProgressCallbackIsACleanNoOp() async throws {
        let f = try fixture(["x.txt": Data("hi".utf8)])
        defer { try? FileManager.default.removeItem(at: f.base) }
        let failures = try await f.engine.run(source: f.source, prefix: .dev)   // omit onRunProgress
        #expect(failures.isEmpty)
    }
}
