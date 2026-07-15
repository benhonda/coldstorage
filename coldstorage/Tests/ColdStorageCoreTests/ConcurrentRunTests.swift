import Testing
import Foundation
import Crypto
@testable import ColdStorageCore

/// **At most one pipeline runs at a time — and the two callers want opposite things when one is in flight.**
///
/// `performRun` awaits S3 for minutes, and a Swift actor is REENTRANT across `await`, so without a lock the
/// 300s scan timer AND every user deposit could each start a pipeline on top of one already running — two
/// passes over the same journal, racing a shared blob's upload id and part rows (observed 2026-07-14, a
/// second run's log interleaved mid-upload). A plain bool was not enough: a scheduled scan should SKIP while
/// busy (the next tick re-scans), but a deposit must WAIT then run (never drop the dropped files). These pin
/// both, plus the invariant underneath: no two `performRun`s are ever active at the same instant.
@Suite struct ConcurrentRunTests {

    /// Tracks how many runs are active at once via the event stream, so "they never overlapped" is a
    /// measured fact (max concurrent == 1), not an assumption.
    final class RunTracker: @unchecked Sendable {
        private let lock = NSLock()
        private var active = 0
        private(set) var started = 0
        private(set) var maxConcurrent = 0
        func onEvent(_ name: String) {
            lock.withLock {
                if name == "runStarted" { active += 1; started += 1; maxConcurrent = max(maxConcurrent, active) }
                if name == "runFinished" { active -= 1 }
            }
        }
        var startedCount: Int { lock.withLock { started } }
        var maxOverlap: Int { lock.withLock { maxConcurrent } }
    }

    private func fixture(fileCount: Int = 3, delayMs: Int = 200)
        throws -> (daemon: DaemonService, session: UserSession, tracker: RunTracker, drop: URL, root: URL) {
        let fm = FileManager.default
        let root = fm.temporaryDirectory.appendingPathComponent("cs-concurrent-\(UUID().uuidString)")
        let drop = root.appendingPathComponent("drop")
        try fm.createDirectory(at: drop, withIntermediateDirectories: true)
        for i in 0..<fileCount { try Data("file \(i)".utf8).write(to: drop.appendingPathComponent("f\(i).txt")) }

        let bus = EventBus()
        let tracker = RunTracker()
        bus.subscribe { tracker.onEvent($0.name) }

        // A delaying store gives a second caller a real window to try to barge in.
        let sessions = SessionFactory(dataRoot: root.appendingPathComponent("data"),
                                      store: FakeVault(delayMs: delayMs), canSelfThaw: false)
        let daemon = DaemonService(bus: bus, sessions: sessions)
        let session = try sessions.make(.user(sub: "sub-1", identityId: "ca-central-1:1"))
        session.vaultKey.setMasterKey(SymmetricKey(size: .bits256))   // a real user starts LOCKED
        return (daemon, session, tracker, drop, root)
    }

    /// A scheduled scan fired mid-deposit must DECLINE — not stack a second pipeline. `runOnce` returns
    /// without running while a deposit holds the lock.
    @Test func aScheduledScanSkipsWhileADepositIsInFlight() async throws {
        let f = try fixture()
        defer { try? FileManager.default.removeItem(at: f.root) }
        await f.daemon.beginSession(f.session)

        let deposit = Task { await f.daemon.deposit(paths: [f.drop.path], into: "") }
        while f.tracker.startedCount == 0 { await Task.yield() }   // deposit genuinely in flight

        try await f.daemon.runOnce()   // the 300s timer fires now
        try await f.daemon.runOnce()

        await deposit.value
        #expect(f.tracker.startedCount == 1)   // only the deposit ran; both scans declined
        #expect(f.tracker.maxOverlap == 1)
    }

    /// Two deposits fired at once must BOTH run (the user's files are never dropped) but must NEVER overlap —
    /// the second waits for the first. This is the wait-then-run path a plain skip-bool couldn't express.
    @Test func twoConcurrentDepositsSerializeAndBothComplete() async throws {
        let f = try fixture(fileCount: 2, delayMs: 150)
        defer { try? FileManager.default.removeItem(at: f.root) }
        await f.daemon.beginSession(f.session)

        // Two separate drops, into different folders so both have real work.
        let a = Task { await f.daemon.deposit(paths: [f.drop.path], into: "A") }
        let b = Task { await f.daemon.deposit(paths: [f.drop.path], into: "B") }
        _ = await (a.value, b.value)

        #expect(f.tracker.startedCount == 2)   // neither deposit was dropped
        #expect(f.tracker.maxOverlap == 1)     // …and they never ran at the same time
        // Both landed in the tree, under their respective folders.
        let files = try f.session.journal.listFiles().map(\.relativePath)
        #expect(files.contains { $0.hasPrefix("A/") })
        #expect(files.contains { $0.hasPrefix("B/") })
    }
}
