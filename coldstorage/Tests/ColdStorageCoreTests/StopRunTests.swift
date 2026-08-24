import Testing
import Foundation
@testable import ColdStorageCore

/// **Stop, end to end through the real engine.** `cancelRun` cancels the Task the engine runs in; these
/// prove what that cancellation actually does against a `FakeVault` that holds every part: the run returns
/// promptly (not after streaming everything), every unfinished blob comes back `.stopped` with its files
/// named (so the daemon can give them journal truth), nothing is reported as a fault, and the blobs that
/// didn't land are left un-archived rather than half-linked.
@Suite struct StopRunTests {

    private func layout(_ files: [String: Data]) throws -> (root: URL, journal: Journal, keys: LocalFileKEK) {
        let fm = FileManager.default
        let base = fm.temporaryDirectory.appendingPathComponent("cs-stop-\(UUID().uuidString)")
        let root = base.appendingPathComponent("data")
        try fm.createDirectory(at: root, withIntermediateDirectories: true)
        for (name, bytes) in files {
            let url = root.appendingPathComponent(name)
            try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try bytes.write(to: url)
        }
        return (root, try Journal(path: base.appendingPathComponent("j.sqlite").path),
                LocalFileKEK(path: base.appendingPathComponent("kek.bin").path))
    }

    /// Three folders → three blobs, each part held 300 ms. Cancel shortly after the first part is in
    /// flight: the run must come back well before the ~1 s it would take to stream all three.
    @Test func cancellingMidRunStopsPromptlyAndReportsTheRestAsStopped() async throws {
        let (root, journal, keys) = try layout([
            "a/one.bin": Data(repeating: 0x11, count: 50_000),
            "b/two.bin": Data(repeating: 0x22, count: 50_000),
            "c/three.bin": Data(repeating: 0x33, count: 50_000),
        ])
        let vault = FakeVault(delayMs: 300)
        let engine = UploadEngine(journal: journal, store: vault, keys: keys)
        let run = Task { try await engine.run(source: LocalDirSource(root: root), prefix: .dev) }
        try await Task.sleep(for: .milliseconds(100))   // inside the first blob's held part
        let t0 = ContinuousClock.now
        run.cancel()
        let failures = try await run.value
        #expect(ContinuousClock.now - t0 < .milliseconds(900))   // did not stream the remaining blobs

        // Everything unfinished is `.stopped` — never a fault — and names its files.
        #expect(!failures.isEmpty)
        let allStopped = failures.allSatisfy { $0.kind.isStopped }
        #expect(allStopped)
        #expect(failures.allSatisfy { !$0.files.isEmpty })
        #expect(failures.allSatisfy { !$0.kind.isPermanent && !$0.kind.isOverQuota })
        // The files in those blobs are NOT archived: a stop leaves them for a later run, never half-linked.
        for f in failures.flatMap(\.files) {
            let archived = try journal.isFileArchived(f.id)
            #expect(archived == false)
        }
        // The ones not reported did land.
        let stoppedIds = Set(failures.flatMap(\.files).map(\.id))
        for id in ["a/one.bin", "b/two.bin", "c/three.bin"] where !stoppedIds.contains(id) {
            let archived = try journal.isFileArchived(id)
            #expect(archived == true)
        }
    }

    /// A stopped run is resumable: run the same source again with no cancellation and everything archives.
    @Test func aStoppedRunFinishesOnTheNextPass() async throws {
        let (root, journal, keys) = try layout([
            "a/one.bin": Data(repeating: 0x11, count: 50_000),
            "b/two.bin": Data(repeating: 0x22, count: 50_000),
        ])
        let vault = FakeVault(delayMs: 200)
        let engine = UploadEngine(journal: journal, store: vault, keys: keys)
        let run = Task { try await engine.run(source: LocalDirSource(root: root), prefix: .dev) }
        try await Task.sleep(for: .milliseconds(50))
        run.cancel()
        _ = try await run.value

        let again = try await engine.run(source: LocalDirSource(root: root), prefix: .dev)
        #expect(again.isEmpty)
        let one = try journal.isFileArchived("a/one.bin"), two = try journal.isFileArchived("b/two.bin")
        #expect(one && two)
    }

    @Test func aCancellationErrorClassifiesAsStoppedOnTheWire() {
        let kind = FailureKind.classify(CancellationError())
        #expect(kind.isStopped)
        #expect(kind.wireKind == "stopped")
        #expect(kind.message == FailureKind.stoppedMessage)
    }
}
