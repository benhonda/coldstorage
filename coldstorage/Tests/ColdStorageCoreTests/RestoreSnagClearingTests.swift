import Testing
import Foundation
@testable import ColdStorageCore

/// **The regression Ben hit (2026-07-27).** An overnight sleep let the daemon's Cognito login token expire;
/// the first restore pass after wake failed on it and recorded a (correctly transient) fault on the warming
/// row — and the "Hit a snag — still trying" note then never left. `restorePass` only wrote the row when its
/// STATE changed, a still-warming row stays `pending` for days, and `Journal.setRestoreState` (the thing
/// that clears `error`) was never reached. These pin the fix: a pass that ANSWERS clears the fault, state
/// change or not — while a clean, unchanged row still writes nothing.
@Suite struct RestoreSnagClearingTests {
    /// A signed-in session over `store` with one archived file (`f1` in blob `b1`) and one live transfer
    /// row (`r1`, in `state`) carrying the recorded overnight fault — the exact shape `restorePass` leaves
    /// behind after a transient failure (state kept, error set).
    private func fixture(store: any Vault, rowState: RestoreState) throws
        -> (daemon: DaemonService, session: UserSession, root: URL) {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("cs-snag-\(UUID().uuidString)", isDirectory: true)
        let sessions = SessionFactory(dataRoot: root, store: store, canSelfThaw: false)
        let session = try sessions.make(.user(sub: "sub-ben", identityId: "ca-central-1:ben"))
        try session.journal.upsert([IngestItem(id: "f1", relativePath: "Photos/beach.jpg", size: 2048,
                                               content: .sha256("hash-f1"), createdAt: nil, isFavorite: false,
                                               open: { AsyncThrowingStream { $0.finish() } })])
        try session.journal.ensureBlob(BlobPlan(id: "b1", items: [], prefix: session.prefix),
                                       noncePrefix: Data(repeating: 1, count: 8),
                                       wrappedDEK: Data(repeating: 2, count: 32))
        try session.journal.markFileArchived("f1", blobId: "b1", offset: 0, length: 2048,
                                             firstFrame: 0, plaintextSha256: "hash-f1", size: 2048)
        try session.journal.addRestore(RestoreRow(id: "r1", fileId: "f1", out: "/tmp/beach.jpg", jobId: nil,
                                                  state: rowState, tier: .bulk, bytes: 2048, requestedAt: 1))
        try session.journal.recordRestoreFault(
            "r1", rowState, error: "S3 NotAuthorizedException: Invalid login token. Token expired")
        return (DaemonService(bus: EventBus(), sessions: sessions), session, root)
    }

    @Test func aGoodPassClearsTheSnagNoteEvenThoughAWarmingRowStaysPending() async throws {
        let f = try fixture(store: StuckVault(at: .inProgress), rowState: .pending)
        defer { try? FileManager.default.removeItem(at: f.root) }
        #expect(try f.session.journal.restore(id: "r1")?.error != nil)

        await f.daemon.restorePass(f.session)   // thaw underway ⇒ success, and the state doesn't move

        let row = try #require(try f.session.journal.restore(id: "r1"))
        #expect(row.state == .pending, "a warming transfer stays pending")
        #expect(row.error == nil, "a recorded fault is history the moment a pass succeeds")
    }

    @Test func aGoodPassClearsTheSnagNoteOnAnUnpaidRowToo() async throws {
        let f = try fixture(store: StuckVault(at: .needed), rowState: .needsAuthorization)
        defer { try? FileManager.default.removeItem(at: f.root) }

        await f.daemon.restorePass(f.session)   // still frozen + may not self-thaw ⇒ needsAuthorization again

        let row = try #require(try f.session.journal.restore(id: "r1"))
        #expect(row.state == .needsAuthorization)
        #expect(row.error == nil, "\"pay first\" is an answer, not a snag — the stale note must go")
    }
}
