import Testing
import Foundation
import Crypto
import Csqlite3
@testable import ColdStorageCore

/// **No command waits behind a tree read.** `listFiles` reads the whole vault, and it used to do that inline
/// on the daemon actor: at sign-in on a 250k-file vault the app's `listFiles` + `listRestores` (then a second
/// whole-tree read), twice over, held the actor for ~10 s, so `unlockVault` — a no-op that loads a key —
/// timed out behind them, and "Couldn't load your files" survived a reboot (2026-09-27; the third stall of
/// this shape after 2026-08-25 and 2026-09-10). Tree reads now run on the journal's own read lane
/// (`Journal.reader`), and `listRestores` looks up only its own files. This replays that sign-in burst
/// against a vault that size.
@Suite struct TreeReadNonBlockingTests {
    @Test func unlockAnswersWhileABigTreeIsBeingRead() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("cs-tr-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let sessions = SessionFactory(dataRoot: root.appendingPathComponent("data"), store: FakeVault(), canSelfThaw: false)
        let daemon = DaemonService(bus: EventBus(), sessions: sessions)
        let session = try sessions.make(.user(sub: "s", identityId: "ca-central-1:1"))
        await daemon.beginSession(session)

        // A vault the size of the one that stalled, written straight into the journal file (seconds via
        // `upsert`; a fraction of that in one statement).
        var db: OpaquePointer?
        try #require(sqlite3_open_v2(session.dir.appendingPathComponent("coldstore.sqlite").path, &db, SQLITE_OPEN_READWRITE, nil) == SQLITE_OK)
        try #require(sqlite3_exec(db, """
            WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 250000)
            INSERT INTO files(id, relativePath, size, contentHash, status, metadata)
            SELECT 'Drop/' || i || '.jpg', 'Drop/' || i || '.jpg', 1, 'h', 'archived', '{"modifiedAt":1700000000}' FROM n;
            """, nil, nil, nil) == SQLITE_OK)
        sqlite3_close(db)

        // The app's connect burst: the tree and the transfers, in flight together…
        let reads = ["listFiles", "listRestores"].enumerated().map { i, method in
            Task {
                let answer = await daemon.respond(to: ControlRequest(id: i + 1, method: method, params: [:]))
                return (answer, ContinuousClock.now)
            }
        }
        try await Task.sleep(for: .milliseconds(20))   // let them reach the daemon first

        // …and the unlock the app sends right behind them answers at once, not after them.
        let key = SymmetricKey(size: .bits256).withUnsafeBytes { Data($0).base64EncodedString() }
        let unlocked = await daemon.respond(to: ControlRequest(id: 3, method: "unlockVault", params: ["masterKey": key]))
        let unlockedAt = ContinuousClock.now
        #expect(unlocked.error == nil)
        #expect(session.vaultKey.isUnlocked)

        let (files, filesAt) = await reads[0].value
        #expect(files.error == nil, "\(files.error ?? "")")
        #expect(unlockedAt < filesAt, "unlockVault waited for the whole tree to be read")
        #expect(await reads[1].value.0.error == nil)
    }
}
