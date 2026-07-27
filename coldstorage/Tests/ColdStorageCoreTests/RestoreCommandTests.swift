import Testing
import Foundation
import Crypto
@testable import ColdStorageCore

/// The transfer command surface, driven over the REAL `DaemonService.respond(to:)` — the same wire the app
/// reads. So these check the actual JSON the UI is handed (field names included, since `protocol.ts` is a
/// hand-maintained mirror of these DTOs and nothing else would catch a drift), not an internal accessor.
///
/// Why this suite exists: a transfer used to be a single request/response the app fired once and then owned
/// in memory. That shape lost the transfer on sign-out, lost it on relaunch, and never progressed past step
/// one. The commands below are the durable replacement, so the behaviours worth pinning are that a transfer
/// is RECORDED, that it comes back on the next read, and that stopping/resuming/forgetting do what their
/// names claim.
@Suite struct RestoreCommandTests {
    /// A vault whose objects are still FROZEN. `FakeVault` reports every object `.ready`, so a transfer
    /// against it downloads and completes within the same run-loop pass — which is the wrong fixture for
    /// testing what happens to a transfer that is still in flight. Frozen + `canSelfThaw: false` is the
    /// real multi-user shape (the daemon may not thaw; the backend must), and it holds a transfer active
    /// deterministically instead of racing the pass.
    private final class FrozenVault: Vault, @unchecked Sendable {
        private let inner = FakeVault()
        func thawState(key: String) async throws -> ThawState { .needed }
        func requestThaw(key: String, days: Int, tier: RestoreTier) async throws {}
        func getRange(key: String, offset: Int, length: Int) async throws -> Data {
            throw ColdStorageError.s3("InvalidObjectState: still frozen")
        }
        func usageBytes(prefix: VaultPrefix) async throws -> Int { try await inner.usageBytes(prefix: prefix) }
        // The upload half is irrelevant here — forward it so the fake stays one implementation, not two.
        func createUpload(key: String) async throws -> String { try await inner.createUpload(key: key) }
        func existingParts(key: String, uploadId: String) async throws -> Set<Int> {
            try await inner.existingParts(key: key, uploadId: uploadId)
        }
        func uploadPart(key: String, uploadId: String, number: Int, data: Data) async throws -> (etag: String, sha: String) {
            try await inner.uploadPart(key: key, uploadId: uploadId, number: number, data: data)
        }
        func complete(key: String, uploadId: String, parts: [PartRow]) async throws {
            try await inner.complete(key: key, uploadId: uploadId, parts: parts)
        }
        func verify(key: String) async throws { try await inner.verify(key: key) }
        func markReclaimable(key: String) async throws { try await inner.markReclaimable(key: key) }
    }

    private func fixture(frozen: Bool = true) -> (daemon: DaemonService, sessions: SessionFactory, root: URL) {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("cs-restorecmd-\(UUID().uuidString)", isDirectory: true)
        // `canSelfThaw: false` = the multi-user daemon, which is the interesting one: it may not thaw, so
        // the paid-retrieval gate is live.
        let store: any Vault = frozen ? FrozenVault() : FakeVault()
        let sessions = SessionFactory(dataRoot: root, store: store, canSelfThaw: false)
        return (DaemonService(bus: EventBus(), sessions: sessions), sessions, root)
    }

    private func reply(_ daemon: DaemonService, _ method: String,
                       _ params: [String: String] = [:]) async throws -> (result: Any?, error: String?) {
        let line = await daemon.respond(to: ControlRequest(id: 1, method: method, params: params))
        guard line.error == nil else { return (nil, line.error) }
        let data = try JSONEncoder().encode(line.result)
        return (try JSONSerialization.jsonObject(with: data), nil)
    }

    private func rows(_ result: Any?) -> [[String: Any]] { result as? [[String: Any]] ?? [] }

    /// Sign in and put one ARCHIVED file in the journal — `requestRestore` reads its blob mapping for the
    /// transfer's byte count, so a merely-discovered row isn't enough.
    private func signedInWithArchivedFile(_ f: (daemon: DaemonService, sessions: SessionFactory, root: URL))
        async throws -> UserSession {
        let s = try f.sessions.make(.user(sub: "sub-ben", identityId: "ca-central-1:ben"))
        await f.daemon.beginSession(s)
        try s.journal.upsert([IngestItem(id: "f1", relativePath: "Photos/beach.jpg", size: 2048,
                                        content: .sha256("hash-f1"), createdAt: nil, isFavorite: false,
                                        open: { AsyncThrowingStream { $0.finish() } })])
        try s.journal.ensureBlob(BlobPlan(id: "b1", items: [], prefix: s.prefix),
                                 noncePrefix: Data(repeating: 1, count: 8),
                                 wrappedDEK: Data(repeating: 2, count: 32))
        try s.journal.markFileArchived("f1", blobId: "b1", offset: 0, length: 2048,
                                       firstFrame: 0, plaintextSha256: "hash-f1", size: 2048)
        return s
    }

    // MARK: - the wire shape the app binds to

    @Test func requestRestoreRecordsATransferAndAnswersWithTheList() async throws {
        let f = fixture()
        defer { try? FileManager.default.removeItem(at: f.root) }
        _ = try await signedInWithArchivedFile(f)

        let out = try await reply(f.daemon, "requestRestore",
                                  ["file": "f1", "out": "/Users/ben/Downloads/beach.jpg", "jobId": "job-77"])
        #expect(out.error == nil)

        let row = try #require(rows(out.result).first)
        // Every field `protocol.ts`'s RestoreRow declares. A rename on either side breaks this test rather
        // than silently handing the app an undefined.
        #expect(row["fileId"] as? String == "f1")
        #expect(row["relativePath"] as? String == "Photos/beach.jpg")
        #expect(row["out"] as? String == "/Users/ben/Downloads/beach.jpg")
        #expect(row["jobId"] as? String == "job-77")
        #expect(row["bytes"] as? Int == 2048)
        #expect(row["tier"] as? String == "bulk")          // the only tier we quote at
        #expect(row["id"] as? String != nil)
        #expect(row["state"] as? String != nil)
        #expect(row["typicalWait"] as? String == "~48 hours")
        #expect(row["resumable"] as? Bool == false)
        #expect(row["requestedAt"] as? Int != nil)
        #expect(row.keys.contains("readyAt"))
        #expect(row.keys.contains("completedAt"))
        #expect(row.keys.contains("error"))
    }

    /// **The regression Ben hit (2026-07-27).** Sign out and back in, and the transfer must still be there.
    /// It used to live only in the renderer, so signing back in showed a plain green "Stored" ✓ and no sign
    /// a copy had ever been asked for.
    @Test func transfersSurviveASignOutAndSignIn() async throws {
        let f = fixture()
        defer { try? FileManager.default.removeItem(at: f.root) }
        _ = try await signedInWithArchivedFile(f)
        _ = try await reply(f.daemon, "requestRestore", ["file": "f1", "out": "/tmp/beach.jpg"])
        #expect(rows(try await reply(f.daemon, "listRestores").result).count == 1)

        await f.daemon.endSession()
        // Signed out ⇒ the empty answer, like every other read: transfers are vault data.
        #expect(rows(try await reply(f.daemon, "listRestores").result).isEmpty)

        // Same user signs back in — the journal still has it.
        let again = try f.sessions.make(.user(sub: "sub-ben", identityId: "ca-central-1:ben"))
        await f.daemon.beginSession(again)
        let back = rows(try await reply(f.daemon, "listRestores").result)
        #expect(back.count == 1)
        #expect(back.first?["relativePath"] as? String == "Photos/beach.jpg")
    }

    /// A different account must not see this Mac's other user's transfers — same isolation rule as the file
    /// tree (see `SessionIsolationTests`), and worth pinning separately because transfers carry destinations
    /// on disk and what someone paid to retrieve.
    @Test func anotherAccountSeesNoneOfTheFirstsTransfers() async throws {
        let f = fixture()
        defer { try? FileManager.default.removeItem(at: f.root) }
        _ = try await signedInWithArchivedFile(f)
        _ = try await reply(f.daemon, "requestRestore", ["file": "f1", "out": "/tmp/beach.jpg"])
        await f.daemon.endSession()

        let other = try f.sessions.make(.user(sub: "sub-alice", identityId: "ca-central-1:alice"))
        await f.daemon.beginSession(other)
        #expect(rows(try await reply(f.daemon, "listRestores").result).isEmpty)
    }

    // MARK: - stop / resume / forget

    @Test func stoppingATransferMarksItCanceled() async throws {
        let f = fixture()
        defer { try? FileManager.default.removeItem(at: f.root) }
        _ = try await signedInWithArchivedFile(f)
        let started = rows(try await reply(f.daemon, "requestRestore", ["file": "f1", "out": "/tmp/beach.jpg"]).result)
        let id = try #require(started.first?["id"] as? String)

        let after = rows(try await reply(f.daemon, "cancelRestore", ["id": id]).result)
        #expect(after.first?["state"] as? String == "canceled")
    }

    @Test func resumingAStoppedTransferPutsItBackToWork() async throws {
        let f = fixture()
        defer { try? FileManager.default.removeItem(at: f.root) }
        _ = try await signedInWithArchivedFile(f)
        let started = rows(try await reply(f.daemon, "requestRestore", ["file": "f1", "out": "/tmp/beach.jpg"]).result)
        let id = try #require(started.first?["id"] as? String)
        _ = try await reply(f.daemon, "cancelRestore", ["id": id])

        let resumed = rows(try await reply(f.daemon, "resumeRestore", ["id": id]).result)
        #expect(resumed.first?["state"] as? String == "pending")
        #expect(resumed.first?["error"] is NSNull || resumed.first?["error"] == nil)
    }

    /// Clearing history is for FINISHED transfers. Letting someone "remove" a live one would leave the run
    /// loop quietly driving a transfer they believe is gone.
    @Test func forgettingRefusesWhileTheTransferIsStillActive() async throws {
        let f = fixture()
        defer { try? FileManager.default.removeItem(at: f.root) }
        _ = try await signedInWithArchivedFile(f)
        let started = rows(try await reply(f.daemon, "requestRestore", ["file": "f1", "out": "/tmp/beach.jpg"]).result)
        let id = try #require(started.first?["id"] as? String)

        // Frozen vault ⇒ the run loop leaves this pending/needsAuthorization, i.e. still active, however
        // many passes run before we get here.
        let refused = try await reply(f.daemon, "forgetRestore", ["id": id])
        #expect(refused.error != nil)
        #expect(rows(try await reply(f.daemon, "listRestores").result).count == 1)

        // Stop it first, and it clears.
        _ = try await reply(f.daemon, "cancelRestore", ["id": id])
        _ = try await reply(f.daemon, "forgetRestore", ["id": id])
        #expect(rows(try await reply(f.daemon, "listRestores").result).isEmpty)
    }

    // MARK: - the pending → transferring → saved sequence

    /// A transfer that runs to completion must end `saved`, with the thaw window (`readyAt`) stamped.
    ///
    /// A REAL round trip: bytes are archived through the session's own `UploadEngine` into the same
    /// `FakeVault` the restore reads back from, so the download genuinely happens and the hash check
    /// genuinely runs. Journaling a file by hand (no bytes behind it) would only ever prove the failure
    /// path, which is how the first version of this test quietly passed for the wrong reason.
    ///
    /// The ordering is the point, and it is a bug I nearly shipped: the `transferring` flip is raised from
    /// inside the engine the moment bytes start moving, while `saved` is written after the download
    /// returns. Hop that flip onto the actor with a `Task` and it can land AFTER `saved`, leaving a
    /// delivered file stuck reading "Transferring" forever.
    @Test func aTransferThatCompletesEndsSavedWithItsWindowStamped() async throws {
        let fm = FileManager.default
        let f = fixture(frozen: false)     // FakeVault: reports thawed AND serves real ranged reads
        defer { try? fm.removeItem(at: f.root) }

        let session = try f.sessions.make(.user(sub: "sub-ben", identityId: "ca-central-1:ben"))
        // Unlock the vault — a multi-user session starts LOCKED, and both halves of the round trip need
        // the MasterKey (the upload wraps a DEK with it, the restore unwraps).
        session.vaultKey.setMasterKey(SymmetricKey(size: .bits256))
        await f.daemon.beginSession(session)

        // Archive a real file through the session's own engine — same journal, same vault the restore uses.
        let src = f.root.appendingPathComponent("src", isDirectory: true)
        try fm.createDirectory(at: src, withIntermediateDirectories: true)
        let payload = Data("the actual bytes we expect to get back".utf8)
        try payload.write(to: src.appendingPathComponent("beach.jpg"))
        let failures = try await session.engine.run(source: LocalDirSource(root: src), prefix: session.prefix)
        #expect(failures.isEmpty)

        let fileId = try #require(try session.journal.listFiles().first?.id)
        let dest = f.root.appendingPathComponent("beach-restored.jpg").path
        _ = try await reply(f.daemon, "requestRestore", ["file": fileId, "out": dest])

        // Let the pass `requestRestore` kicked off run to completion.
        try await Task.sleep(for: .milliseconds(400))

        let row = try #require(try session.journal.listRestores().first)
        #expect(row.state == .saved, "ended \(row.state) (\(row.error ?? "no error")) — a completed transfer must not be left mid-flight")
        #expect(!row.state.isActive)
        #expect(row.completedAt != nil)
        #expect(row.readyAt != nil, "the 5-day window must be stamped, or a free resume can never be offered")
        // And the file really came back.
        #expect(try Data(contentsOf: URL(fileURLWithPath: dest)) == payload)
    }

    /// Asking for a file again SUPERSEDES the transfer of it still in flight, rather than stacking a
    /// second live row beside it. Without this, the "Ask again" way out of a stalled transfer leaves the
    /// dead one sitting in "In progress" and padding the sidebar count for good.
    @Test func askingAgainSupersedesTheTransferStillInFlight() async throws {
        let f = fixture()          // frozen vault ⇒ the first transfer stays active
        defer { try? FileManager.default.removeItem(at: f.root) }
        let session = try await signedInWithArchivedFile(f)

        let first = rows(try await reply(f.daemon, "requestRestore", ["file": "f1", "out": "/tmp/a.jpg"]).result)
        let firstId = try #require(first.first?["id"] as? String)

        _ = try await reply(f.daemon, "requestRestore", ["file": "f1", "out": "/tmp/b.jpg"])

        let all = try session.journal.listRestores()
        #expect(all.count == 2, "history keeps both — superseding is not deleting")
        #expect(try session.journal.activeRestores().count == 1, "only the newest request may be live")
        #expect(all.first(where: { $0.id == firstId })?.state == .canceled)
    }

    // MARK: - refusals

    @Test func requestingAnUnknownFileIsRejected() async throws {
        let f = fixture()
        defer { try? FileManager.default.removeItem(at: f.root) }
        _ = try await signedInWithArchivedFile(f)
        let out = try await reply(f.daemon, "requestRestore", ["file": "nope", "out": "/tmp/x"])
        #expect(out.error != nil)
    }

    @Test func requestRestoreNeedsBothFileAndDestination() async throws {
        let f = fixture()
        defer { try? FileManager.default.removeItem(at: f.root) }
        _ = try await signedInWithArchivedFile(f)
        #expect(try await reply(f.daemon, "requestRestore", ["file": "f1"]).error != nil)
        #expect(try await reply(f.daemon, "requestRestore", ["out": "/tmp/x"]).error != nil)
    }

    @Test func signedOutDaemonRefusesToStartATransfer() async throws {
        let f = fixture()
        defer { try? FileManager.default.removeItem(at: f.root) }
        #expect(try await reply(f.daemon, "requestRestore", ["file": "f1", "out": "/tmp/x"]).error != nil)
    }
}
