import Testing
import Foundation
@testable import ColdStorageCore

/// **The regression Ben hit (2026-08-21).** A transfer sat on the Transfers page reading "Pending" — which
/// asserts something specific and current, that S3 says a thaw is running *right now* — with an "asked" date
/// a month old. `pending` was unfalsifiable: the row's only clock was `requestedAt`, so a healthy 48-hour
/// wait and a transfer nothing had looked at since July rendered as identical pixels, forever.
///
/// `RestoreRow.lastStepAt` is the missing half. These pin the one property that makes it worth having: the
/// run loop stamps it on EVERY outcome, including the ones that write nothing else. A freshness clock that
/// only ticks when things go well would go quiet in exactly the situation it exists to expose.
@Suite struct RestoreFreshnessTests {
    /// A signed-in session over `store` with one archived file (`f1` in blob `b1`) and one live transfer row
    /// (`r1`) that has never been stepped — `lastStepAt` nil, as a freshly requested transfer really is.
    /// `canSelfThaw: false` puts it in the multi-user shape, where a frozen blob means "pay first".
    private func fixture(store: any Vault, rowState: RestoreState = .pending) throws
        -> (daemon: DaemonService, session: UserSession, root: URL) {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("cs-fresh-\(UUID().uuidString)", isDirectory: true)
        let sessions = SessionFactory(dataRoot: root, store: store, canSelfThaw: false)
        let session = try sessions.make(.user(sub: "sub-ben", identityId: "ca-central-1:ben"))
        try session.journal.upsert([IngestItem(id: "f1", relativePath: "Photos/beach.jpg", size: 2048,
                                               content: .sha256("hash-f1"), isFavorite: false,
                                               open: { AsyncThrowingStream { $0.finish() } })])
        try session.journal.ensureBlob(BlobPlan(id: "b1", items: [], prefix: session.prefix),
                                       noncePrefix: Data(repeating: 1, count: 8),
                                       wrappedDEK: Data(repeating: 2, count: 32))
        try session.journal.markFileArchived("f1", blobId: "b1", offset: 0, length: 2048,
                                             firstFrame: 0, plaintextSha256: "hash-f1", size: 2048)
        try session.journal.addRestore(RestoreRow(id: "r1", fileId: "f1", out: "/tmp/beach.jpg", jobId: nil,
                                                  state: rowState, tier: .bulk, bytes: 2048, requestedAt: 1))
        return (DaemonService(bus: EventBus(), sessions: sessions), session, root)
    }

    @Test func aFreshlyRequestedTransferHasNeverBeenChecked() throws {
        let f = try fixture(store: StuckVault(at: .inProgress))
        defer { try? FileManager.default.removeItem(at: f.root) }
        // Deliberately NOT backfilled from `requestedAt`: "asked for" and "checked on" are different facts,
        // and seeding one from the other is the exact lie this column exists to stop telling.
        #expect(try f.session.journal.restore(id: "r1")?.lastStepAt == nil)
    }

    /// The case the whole thing is for: a warming row writes nothing else all pass — same state, no fault —
    /// so before `lastStepAt` a pass over it was completely invisible to the page.
    @Test func aWarmingRowIsStampedEvenThoughNothingElseAboutItChanges() async throws {
        let f = try fixture(store: StuckVault(at: .inProgress))
        defer { try? FileManager.default.removeItem(at: f.root) }
        let before = Int(Date().timeIntervalSince1970)

        await f.daemon.restorePass(f.session)

        let row = try #require(try f.session.journal.restore(id: "r1"))
        #expect(row.state == .pending, "still warming — the state genuinely didn't move")
        #expect(row.error == nil)
        #expect((row.lastStepAt ?? 0) >= before, "a pass that reported no news still has to record that it looked")
    }

    /// "Pay first" is an answer too. This row is going nowhere until the user acts, which is precisely when
    /// the page must be able to say how long it has been that way.
    @Test func anUnpaidRowIsStamped() async throws {
        let f = try fixture(store: StuckVault(at: .needed))
        defer { try? FileManager.default.removeItem(at: f.root) }
        let before = Int(Date().timeIntervalSince1970)

        await f.daemon.restorePass(f.session)

        let row = try #require(try f.session.journal.restore(id: "r1"))
        #expect(row.state == .needsAuthorization)
        #expect((row.lastStepAt ?? 0) >= before)
    }

    /// A pass that THREW still looked. `lastStepAt` answers "did anything check on this?"; `error` answers
    /// "how did it go" — keeping them separate is what lets the page say "we're on it, but we hit a snag"
    /// instead of collapsing both into one silence.
    @Test func aFailedPassIsStampedToo() async throws {
        // A network-shaped error, so `FailureKind` classifies it TRANSIENT and the row stays in flight —
        // the realistic mid-thaw blip (a `ColdStorageError` here would be a config fault, i.e. terminal).
        let f = try fixture(store: StuckVault(at: .inProgress, failingWith: URLError(.timedOut)))
        defer { try? FileManager.default.removeItem(at: f.root) }
        let before = Int(Date().timeIntervalSince1970)

        await f.daemon.restorePass(f.session)

        let row = try #require(try f.session.journal.restore(id: "r1"))
        #expect(row.state == .pending, "a transient fault leaves the transfer in flight for the next pass")
        #expect(row.error != nil, "and records why")
        #expect((row.lastStepAt ?? 0) >= before, "the stamp is not conditional on the step succeeding")
    }

    /// The staleness threshold is the DAEMON's to state, because only it knows how often it promised to
    /// look — the app hardcoding "a day" was right for the default beat and silently wrong for any other,
    /// and `COLDSTORE_INTERVAL` makes the beat configurable. Same lesson as the deleted rate card.
    @Test func theStalenessThresholdFollowsTheLoopsRealBeat() {
        // At the default 300s beat the floor governs: a day of silence, ~288 missed passes.
        #expect(RestoreRow.staleAfter(intervalSeconds: DaemonService.defaultIntervalSeconds) == 24 * 60 * 60)
        // A deliberately slow daemon must not have every row read stalled on the next render.
        #expect(RestoreRow.staleAfter(intervalSeconds: 6 * 60 * 60) == 6 * 24 * 60 * 60)
    }

    /// The stamp is a single-column write on purpose — it must not be able to disturb the state machine or
    /// stomp a fault the same pass just recorded.
    @Test func stampingTouchesNothingButTheClock() throws {
        let f = try fixture(store: StuckVault(at: .inProgress))
        defer { try? FileManager.default.removeItem(at: f.root) }
        try f.session.journal.recordRestoreFault("r1", .pending, error: "a snag")

        try f.session.journal.stampRestoreStep("r1", at: 1_800_000_000)

        let row = try #require(try f.session.journal.restore(id: "r1"))
        #expect(row.lastStepAt == 1_800_000_000)
        #expect(row.state == .pending)
        #expect(row.error == "a snag")
    }
}
