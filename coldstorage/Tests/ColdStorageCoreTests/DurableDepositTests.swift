import Testing
import Foundation
import Crypto
@testable import ColdStorageCore

/// **A drop survives the daemon dying.** Watched folders always resumed (they're re-scanned every pass);
/// an explicit deposit did not — kill the daemon mid-way and its files sat "uploading" forever with nobody
/// uploading them (2026-08-25). Now the deposit is journaled BEFORE it runs (`Deposit`), and the
/// scheduled pass replays whatever is still owed. These drive the real `DaemonService` + engine against a
/// `FakeVault`: a stopped deposit stays owed and the next `runOnce` finishes it; a completed one settles
/// into a `done` row that owns its files (the Uploads page's batch); a replay never revives a file the user
/// deleted in between; and "Try again" reopens the SAME batch rather than minting another.
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

    @Test func aCompletedDepositSettlesIntoABatchThatOwnsItsFiles() async throws {
        let f = try fixture()
        defer { try? FileManager.default.removeItem(at: f.root) }
        await f.daemon.beginSession(f.session)
        await f.daemon.deposit(paths: [f.drop.path], into: "")
        #expect(try f.session.journal.pendingDeposits().isEmpty)
        #expect(try f.session.journal.isFileArchived("drop/d0/f0.bin"))
        // The row is history now, not a to-do: done, stamped, and every file points back at it.
        let batch = try #require(try f.session.journal.listDeposits().first)
        #expect(batch.state == .done && batch.finishedAt != nil && batch.mode == .ingest)
        #expect(try f.session.journal.listFiles().filter { $0.status == .archived }.allSatisfy { $0.depositId == batch.id })
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
        let pending = try f.session.journal.pendingDeposits()
        #expect(pending.count == 1)
        #expect(pending.first?.src == [f.drop.path])
        let archivedBefore = try ["d0/f0", "d1/f1", "d2/f2"].filter { try f.session.journal.isFileArchived("drop/\($0).bin") }
        #expect(archivedBefore.count < 3)

        // The scheduled pass (what runs after a restart) pays the rest and clears the row.
        try await f.daemon.runOnce()
        #expect(try f.session.journal.pendingDeposits().isEmpty)
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
        #expect(try f.session.journal.pendingDeposits().isEmpty)
        #expect(try f.session.journal.isFileArchived(victim) == false)   // deletion outranks the replay
    }

    /// "Try again" on a batch that didn't finish reopens THAT row in `.retry` mode, finishes its own rows in
    /// place, and settles it again — one line on the Uploads page for one thing the user did, whose counts
    /// move. Never a second deposit.
    @Test func aRetryReopensTheSameBatchAndFinishesItInPlace() async throws {
        let f = try fixture()
        defer { try? FileManager.default.removeItem(at: f.root) }
        await f.daemon.beginSession(f.session)
        await f.daemon.deposit(paths: [f.drop.path], into: "")
        let batch = try #require(try f.session.journal.listDeposits().first)
        #expect(try f.session.journal.depositFiles(batch.id, statuses: [.archived]).count == 3)
        // A fourth file of the same batch that a permanent fault left behind (journaled the way the engine
        // would have: claimed by the batch, with its source on disk, then marked failed).
        let extra = f.drop.appendingPathComponent("d3/f3.bin")
        try FileManager.default.createDirectory(at: extra.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(repeating: 9, count: 40_000).write(to: extra)
        let failedId = "drop/d3/f3.bin"
        try f.session.journal.upsert([Self.item(failedId, sourcePath: extra.path)], depositId: batch.id)
        try f.session.journal.markFilesFailed([failedId], kind: .permanent, error: "S3 AccessDenied")

        let r = try await f.daemon.retryFiles(.deposit(batch.id), sourcePath: nil)
        #expect(r.queued == 1 && r.missing == 0)
        // Reopened, same id, retry mode — and still the only deposit.
        let reopened = try #require(try f.session.journal.deposit(id: batch.id))
        #expect(reopened.state == .pending && reopened.mode == .retry && reopened.finishedAt == nil)
        #expect(try f.session.journal.listDeposits().count == 1)

        // The retry runs in the background; the next pass (what a restart would do) is the deterministic wait.
        try await f.daemon.runOnce()
        var settled = try #require(try f.session.journal.deposit(id: batch.id))
        for _ in 0..<50 where settled.state != .done {
            try await Task.sleep(for: .milliseconds(50))
            settled = try #require(try f.session.journal.deposit(id: batch.id))
        }
        #expect(settled.state == .done && settled.mode == .retry)
        #expect(try f.session.journal.isFileArchived(failedId))
        #expect(try f.session.journal.depositFiles(batch.id, statuses: [.failed]).isEmpty)
        #expect(try f.session.journal.depositFiles(batch.id, statuses: [.archived]).count == 4)
    }

    /// "Try again" on a batch that is still OWED never reopens it: it is already going to be replayed, and
    /// rewriting its mode to `.retry` would stop that replay re-enumerating the drop. The rows are requeued
    /// and the pass is brought forward instead.
    @Test func aRetryOnAStillPendingBatchDoesNotRewriteItsMode() async throws {
        let f = try fixture()
        defer { try? FileManager.default.removeItem(at: f.root) }
        await f.daemon.beginSession(f.session)
        // A drop still owed (never ran) with one of its rows already marked failed.
        let pending = Deposit(id: "d-owed", kind: .files, src: [f.drop.path], dest: "", conflicts: [:], excludeExtra: [], createdAt: 1)
        try f.session.journal.addDeposit(pending)
        try f.session.journal.upsert([Self.item("drop/d0/f0.bin", sourcePath: f.drop.appendingPathComponent("d0/f0.bin").path)], depositId: pending.id)
        try f.session.journal.markFilesFailed(["drop/d0/f0.bin"], kind: .stopped)

        let r = try await f.daemon.retryFiles(.deposit(pending.id), sourcePath: nil)
        #expect(r.queued == 1)
        let after = try #require(try f.session.journal.deposit(id: pending.id))
        #expect(after.state == .pending && after.mode == .ingest)   // untouched: still the drop it was
        #expect(try f.session.journal.deposit(id: pending.id)?.finishedAt == nil)
        // And the pass it rides finishes the whole drop from `src`, as an owed drop must.
        try await f.daemon.runOnce()
        for i in 0..<3 { #expect(try f.session.journal.isFileArchived("drop/d\(i)/f\(i).bin")) }
        #expect(try f.session.journal.deposit(id: pending.id)?.state == .done)
    }

    /// A batch with nothing left to retry can be dropped from the history; one still holding a failed file
    /// cannot — a failure with no batch to show under is the state this table exists to end.
    @Test func forgettingABatchIsRefusedWhileAFileIsStillFailed() async throws {
        let f = try fixture()
        defer { try? FileManager.default.removeItem(at: f.root) }
        await f.daemon.beginSession(f.session)
        await f.daemon.deposit(paths: [f.drop.path], into: "")
        let batch = try #require(try f.session.journal.listDeposits().first)
        try f.session.journal.upsert([Self.item("drop/d3/f3.bin", sourcePath: nil)], depositId: batch.id)
        try f.session.journal.markFilesFailed(["drop/d3/f3.bin"], kind: .interrupted)
        #expect(throws: ColdStorageError.self) { try f.session.journal.forgetDeposit(batch.id) }
        // Remove the failed file, and the batch can go; its stored files stay in the tree, unowned.
        #expect(try f.session.journal.removeFailedFiles(inDeposit: batch.id) == 1)
        try f.session.journal.forgetDeposit(batch.id)
        #expect(try f.session.journal.listDeposits().isEmpty)
        #expect(try f.session.journal.listFiles().count == 3)
        #expect(try f.session.journal.listFiles().allSatisfy { $0.depositId == nil })
    }

    private static func item(_ path: String, sourcePath: String?) -> IngestItem {
        IngestItem(id: path, relativePath: path, size: 40_000, content: .sha256(String(repeating: "b", count: 64)),
                   isFavorite: false, sourcePath: sourcePath,
                   open: { AsyncThrowingStream { $0.finish() } })
    }

    final class Started: @unchecked Sendable {
        private let lock = NSLock(); private var v = false
        func mark() { lock.withLock { v = true } }
        var value: Bool { lock.withLock { v } }
    }
}
