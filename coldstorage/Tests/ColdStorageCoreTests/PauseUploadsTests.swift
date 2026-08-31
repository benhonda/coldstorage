import Testing
import Foundation
@testable import ColdStorageCore

/// **Pause, end to end through the real engine** (PAUSE.md). Where Stop (`StopRunTests`) proves a cancelled
/// run closes out `.stopped` and returns, these prove the pause gate does the opposite: the run PARKS in
/// place — no failures, no `runFinished`-shaped early return — and `resume()` releases it exactly where it
/// held, with every part sent exactly once (drain-don't-kill: nothing in flight is discarded, nothing is
/// re-sent). Plus the two edges that make pause trustworthy: a cancel while parked still stops promptly,
/// and the paused flag survives in the journal.
@Suite struct PauseUploadsTests {

    private func layout(_ files: [String: Data]) throws -> (root: URL, journal: Journal, keys: LocalFileKEK) {
        let fm = FileManager.default
        let base = fm.temporaryDirectory.appendingPathComponent("cs-pause-\(UUID().uuidString)")
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

    /// A gate paused before the run starts: the run scans and plans, then parks before the first blob —
    /// nothing uploads, nothing fails — and `resume()` releases it to finish cleanly.
    @Test func aPausedRunParksAndResumeReleasesIt() async throws {
        let (root, journal, keys) = try layout([
            "a/one.bin": Data(repeating: 0x11, count: 50_000),
            "b/two.bin": Data(repeating: 0x22, count: 50_000),
        ])
        let vault = FakeVault()
        let engine = UploadEngine(journal: journal, store: vault, keys: keys)
        let gate = PauseGate()
        await gate.pause()
        let run = Task { try await engine.run(source: LocalDirSource(root: root), prefix: .dev, gate: gate) }
        try await Task.sleep(for: .milliseconds(300))
        // Parked, not failed: no part has been sent and neither file is archived — and the run is still alive.
        #expect(vault.uploadPartCalls == 0)
        #expect(try journal.isFileArchived("a/one.bin") == false)
        await gate.resume()
        let failures = try await run.value
        #expect(failures.isEmpty)   // a pause is never reported as `.stopped` or any other failure
        #expect(try journal.isFileArchived("a/one.bin"))
        #expect(try journal.isFileArchived("b/two.bin"))
    }

    /// Pause mid-run: the part in flight finishes (drain, don't kill — its blob archives), the next blob
    /// parks, and resume completes the rest with every part sent exactly once. The `uploadPartCalls` count
    /// is the zero-waste claim made checkable: a pause/resume cycle re-sends nothing.
    @Test func pausingMidRunDrainsInFlightThenHoldsUntilResume() async throws {
        let (root, journal, keys) = try layout([
            "a/one.bin": Data(repeating: 0x11, count: 50_000),
            "b/two.bin": Data(repeating: 0x22, count: 50_000),
        ])
        let vault = FakeVault(delayMs: 200)
        let engine = UploadEngine(journal: journal, store: vault, keys: keys)
        let gate = PauseGate()
        let run = Task { try await engine.run(source: LocalDirSource(root: root), prefix: .dev, gate: gate) }
        try await Task.sleep(for: .milliseconds(100))   // inside the first blob's held part
        await gate.pause()
        // Let the in-flight part land and the run settle against the gate: the first blob completes
        // (drain), the second parks — visibly held, not stopped, not failed.
        try await Task.sleep(for: .milliseconds(600))
        #expect(try journal.isFileArchived("a/one.bin"))
        #expect(try journal.isFileArchived("b/two.bin") == false)
        await gate.resume()
        let failures = try await run.value
        #expect(failures.isEmpty)
        #expect(try journal.isFileArchived("b/two.bin"))
        #expect(vault.uploadPartCalls == 2)   // one part per blob, each sent once — nothing discarded or re-sent
    }

    /// Cancellation outranks pause: `cancelRun` against a PARKED run must still stop it promptly, closing
    /// out with `.stopped` exactly like a cancel against a streaming run — never a hang, never a fault.
    @Test func cancellingAParkedRunStopsPromptly() async throws {
        let (root, journal, keys) = try layout([
            "a/one.bin": Data(repeating: 0x11, count: 50_000),
            "b/two.bin": Data(repeating: 0x22, count: 50_000),
        ])
        let vault = FakeVault()
        let engine = UploadEngine(journal: journal, store: vault, keys: keys)
        let gate = PauseGate()
        await gate.pause()
        let run = Task { try await engine.run(source: LocalDirSource(root: root), prefix: .dev, gate: gate) }
        try await Task.sleep(for: .milliseconds(200))   // parked at the first blob
        let t0 = ContinuousClock.now
        run.cancel()
        let failures = try await run.value
        #expect(ContinuousClock.now - t0 < .milliseconds(900))
        #expect(!failures.isEmpty)
        #expect(failures.allSatisfy { $0.kind.isStopped })
        for f in failures.flatMap(\.files) {
            #expect(try journal.isFileArchived(f.id) == false)
        }
    }

    /// The persistence half: the latch the daemon seeds `PauseGate` from at session start. Default is
    /// unpaused; a toggle round-trips; and it's per-journal, which is what makes it per-user.
    @Test func uploadsPausedRoundTripsThroughTheJournal() throws {
        let base = FileManager.default.temporaryDirectory.appendingPathComponent("cs-pause-j-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        let journal = try Journal(path: base.appendingPathComponent("j.sqlite").path)
        #expect(try journal.uploadsPaused() == false)
        try journal.setUploadsPaused(true)
        #expect(try journal.uploadsPaused())
        try journal.setUploadsPaused(false)
        #expect(try journal.uploadsPaused() == false)
    }
}
