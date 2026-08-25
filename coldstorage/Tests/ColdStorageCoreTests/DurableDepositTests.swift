import Testing
import Foundation
import Crypto
@testable import ColdStorageCore

/// **A drop survives the daemon dying.** Watched folders always resumed (they're re-scanned every pass);
/// an explicit deposit did not — kill the daemon mid-way and its files sat "uploading" forever with nobody
/// uploading them (2026-08-25). Now the deposit is journaled BEFORE it runs (`PendingDeposit`), and the
/// scheduled pass replays whatever is still owed. These drive the real `DaemonService` + engine against a
/// `FakeVault`: a stopped deposit leaves its row and the next `runOnce` finishes it; a completed one leaves
/// nothing behind; a replay never revives a file the user deleted in between.
@Suite struct DurableDepositTests {

    private func fixture(fileCount: Int = 3, delayMs: Int = 0)
        throws -> (daemon: DaemonService, session: UserSession, drop: URL, root: URL, bus: EventBus) {
        let fm = FileManager.default
        let root = fm.temporaryDirectory.appendingPathComponent("cs-durable-\(UUID().uuidString)")
        let drop = root.appendingPathComponent("drop")
        try fm.createDirectory(at: drop, withIntermediateDirectories: true)
        for i in 0..<fileCount {
            // Separate folders → separate blobs, so a stop can land between them.
            let dir = drop.appendingPathComponent("d\(i)")
            try fm.createDirectory(at: dir, withIntermediateDirectories: true)
            try Data(repeating: UInt8(i), count: 40_000).write(to: dir.appendingPathComponent("f\(i).bin"))
        }
        let bus = EventBus()
        let sessions = SessionFactory(dataRoot: root.appendingPathComponent("data"),
                                      store: FakeVault(delayMs: delayMs), canSelfThaw: false)
        let daemon = DaemonService(bus: bus, sessions: sessions)
        let session = try sessions.make(.user(sub: "sub-1", identityId: "ca-central-1:1"))
        session.vaultKey.setMasterKey(SymmetricKey(size: .bits256))
        return (daemon, session, drop, root, bus)
    }

    @Test func aCompletedDepositLeavesNoPendingRow() async throws {
        let f = try fixture()
        defer { try? FileManager.default.removeItem(at: f.root) }
        await f.daemon.beginSession(f.session)
        await f.daemon.deposit(paths: [f.drop.path], into: "")
        #expect(try f.session.journal.listPendingDeposits().isEmpty)
        #expect(try f.session.journal.isFileArchived("drop/d0/f0.bin"))
    }

    @Test func aStoppedDepositIsFinishedByTheNextPass() async throws {
        let f = try fixture(delayMs: 300)
        defer { try? FileManager.default.removeItem(at: f.root) }
        await f.daemon.beginSession(f.session)

        let started = Started()
        f.bus.subscribe { if $0.name == "runStarted" { started.mark() } }
        let deposit = Task { await f.daemon.deposit(paths: [f.drop.path], into: "") }
        while !started.value { await Task.yield() }
        try await Task.sleep(for: .milliseconds(100))
        _ = await f.daemon.cancelRun()
        await deposit.value

        // Owed: the row is still there, and not every file landed.
        let pending = try f.session.journal.listPendingDeposits()
        #expect(pending.count == 1)
        #expect(pending.first?.src == [f.drop.path])
        let archivedBefore = try ["d0/f0", "d1/f1", "d2/f2"].filter { try f.session.journal.isFileArchived("drop/\($0).bin") }
        #expect(archivedBefore.count < 3)

        // The scheduled pass (what runs after a restart) pays the rest and clears the row.
        try await f.daemon.runOnce()
        #expect(try f.session.journal.listPendingDeposits().isEmpty)
        for i in 0..<3 { #expect(try f.session.journal.isFileArchived("drop/d\(i)/f\(i).bin")) }
    }

    @Test func aReplayDoesNotReviveAFileDeletedInBetween() async throws {
        let f = try fixture(delayMs: 300)
        defer { try? FileManager.default.removeItem(at: f.root) }
        await f.daemon.beginSession(f.session)
        let started = Started()
        f.bus.subscribe { if $0.name == "runStarted" { started.mark() } }
        let deposit = Task { await f.daemon.deposit(paths: [f.drop.path], into: "") }
        while !started.value { await Task.yield() }
        try await Task.sleep(for: .milliseconds(100))
        _ = await f.daemon.cancelRun()
        await deposit.value

        // The user deletes one of the still-pending files in the app before the replay.
        let pendingIds = try (0..<3).map { "drop/d\($0)/f\($0).bin" }.filter { try !f.session.journal.isFileArchived($0) }
        let victim = try #require(pendingIds.first)
        try f.session.journal.deletePath(victim)

        try await f.daemon.runOnce()
        #expect(try f.session.journal.listPendingDeposits().isEmpty)
        #expect(try f.session.journal.isFileArchived(victim) == false)   // deletion outranks the replay
    }

    final class Started: @unchecked Sendable {
        private let lock = NSLock(); private var v = false
        func mark() { lock.withLock { v = true } }
        var value: Bool { lock.withLock { v } }
    }
}
