import Testing
import Foundation
import Crypto
@testable import ColdStorageCore

/// **A file nothing can resume must not spin "Uploading" forever.** A drop interrupted on a build older
/// than durable deposits leaves `planned` files with no pending-deposit row and no watched source — nothing
/// drives them, and the stall detector never fires (no `lastAttemptAt`). The scheduled pass now flips those
/// to `failed` as `.interrupted` AND gives them a batch to show under, so the Uploads page can list them and
/// offer a way out. Files a source or a pending deposit still owns are left alone.
@Suite struct OrphanedUploadTests {

    private func fixture() throws -> (daemon: DaemonService, session: UserSession, root: URL) {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("cs-orphan-\(UUID().uuidString)")
        let sessions = SessionFactory(dataRoot: root.appendingPathComponent("data"), store: FakeVault(), canSelfThaw: false)
        let daemon = DaemonService(bus: EventBus(), sessions: sessions)
        let session = try sessions.make(.user(sub: "s", identityId: "ca-central-1:1"))
        session.vaultKey.setMasterKey(SymmetricKey(size: .bits256))
        return (daemon, session, root)
    }

    /// Two planned files, no source, no pending deposit → both flip to failed as `.interrupted` on a pass,
    /// and land in one synthetic batch named by their top-level folder.
    @Test func orphanedPlannedFilesBecomeNeedsAttention() async throws {
        let f = try fixture()
        defer { try? FileManager.default.removeItem(at: f.root) }
        // Seed planned files directly (what an interrupted drop left behind), then run a pass.
        try f.session.journal.upsert([
            item("Photos/a.jpg"), item("Photos/b.jpg"),
        ])
        await f.daemon.beginSession(f.session)
        try await f.daemon.runOnce()

        let batch = try #require(try f.session.journal.listDeposits().first)
        #expect(batch.state == .done && batch.mode == .retry && batch.src == ["Photos"])
        for id in ["Photos/a.jpg", "Photos/b.jpg"] {
            let row = try #require(try f.session.journal.listFiles().first { $0.id == id })
            #expect(row.status == .failed)
            #expect(row.failureKind == .interrupted && row.error == nil)
            #expect(row.depositId == batch.id)
        }
        // A second pass adopts nothing new — the batch is stable, not re-minted every tick.
        try await f.daemon.runOnce()
        #expect(try f.session.journal.listDeposits().count == 1)
    }

    /// A file UNDER a watched source's mount is left alone — a scan still drives it.
    @Test func filesUnderAWatchedSourceAreNotTouched() async throws {
        let f = try fixture()
        defer { try? FileManager.default.removeItem(at: f.root) }
        try f.session.journal.addSource(SourceRow(id: "/src", kind: .folder, path: "/src", mountPath: "Camera"))
        try f.session.journal.upsert([item("Camera/live.jpg"), item("Photos/orphan.jpg")])
        await f.daemon.beginSession(f.session)
        try await f.daemon.runOnce()

        let camera = try #require(try f.session.journal.listFiles().first { $0.id == "Camera/live.jpg" })
        #expect(camera.status == .planned)   // under a source → untouched
        let orphan = try #require(try f.session.journal.listFiles().first { $0.id == "Photos/orphan.jpg" })
        #expect(orphan.status == .failed)    // not under any source → needs attention
    }

    /// While a pending deposit is still owed, the sweep is skipped — its replay owns those files. A photos
    /// deposit on a daemon with no PhotoKit resolver persists (its replay is a clean no-op return), which is
    /// exactly the "deposit present, hasn't settled" window the guard protects.
    @Test func aPendingDepositSuppressesTheSweep() async throws {
        let f = try fixture()
        defer { try? FileManager.default.removeItem(at: f.root) }
        try f.session.journal.upsert([item("Photos/a.jpg")])
        try f.session.journal.addDeposit(Deposit(
            id: "d1", kind: .photos, src: ["asset-1"], dest: "", conflicts: [:], excludeExtra: [], createdAt: 1))
        await f.daemon.beginSession(f.session)
        try await f.daemon.runOnce()
        let row = try #require(try f.session.journal.listFiles().first { $0.id == "Photos/a.jpg" })
        #expect(row.status == .planned)   // not condemned while a deposit is pending
        #expect(try f.session.journal.pendingDeposits().count == 1) // and the deposit is still owed
    }

    private func item(_ path: String) -> IngestItem {
        IngestItem(id: path, relativePath: path, size: 10, content: .sha256(String(repeating: "a", count: 64)),
                   isFavorite: false, open: { AsyncThrowingStream { $0.yield(Data(repeating: 1, count: 10)); $0.finish() } })
    }
}
