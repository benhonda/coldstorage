import Testing
import Foundation
@testable import ColdStorageCore

/// The transfers registry — a requested restore is a durable journal row, not app state.
///
/// That's the whole point of these: an app-held transfer vanished on sign-out, vanished on restart, and
/// could never progress with the app closed. So the coverage that matters here is the *persistence* and
/// *state-transition* behaviour a Transfers page depends on, exercised against the real SQLite path.
@Suite struct JournalRestoresTests {
    private func tempJournal() throws -> Journal {
        let path = FileManager.default.temporaryDirectory
            .appendingPathComponent("cs-restores-\(ProcessInfo.processInfo.processIdentifier)-\(UUID().uuidString).sqlite").path
        return try Journal(path: path)
    }

    private func row(_ id: String, state: RestoreState = .pending, at: Int = 1_000,
                     readyAt: Int? = nil, jobId: String? = "job-1") -> RestoreRow {
        RestoreRow(id: id, fileId: "f-\(id)", out: "/tmp/\(id).jpg", jobId: jobId, state: state,
                   tier: .bulk, bytes: 1_234, requestedAt: at, readyAt: readyAt)
    }

    // MARK: - persistence

    @Test func addAndListRoundTrips() throws {
        let j = try tempJournal()
        #expect(try j.listRestores().isEmpty)

        try j.addRestore(row("a", at: 100))
        let got = try #require(try j.listRestores().first)
        #expect(got.id == "a")
        #expect(got.fileId == "f-a")
        #expect(got.out == "/tmp/a.jpg")
        #expect(got.jobId == "job-1")
        #expect(got.state == .pending)
        #expect(got.tier == .bulk)
        #expect(got.bytes == 1_234)
        #expect(got.requestedAt == 100)
        #expect(got.readyAt == nil)
        #expect(got.completedAt == nil)
        #expect(got.error == nil)
    }

    /// THE regression this table exists for: a transfer must still be there on the next read, whoever is
    /// asking and whenever. Reopening the same file is the closest a unit test gets to "signed out, signed
    /// back in, relaunched" — the app's copy was gone in all three, the journal's is not.
    @Test func survivesReopen() throws {
        let path = FileManager.default.temporaryDirectory
            .appendingPathComponent("cs-restores-persist-\(UUID().uuidString).sqlite").path
        do {
            let j = try Journal(path: path)
            try j.addRestore(row("a", state: .transferring))
        }
        let reopened = try Journal(path: path)
        let got = try #require(try reopened.listRestores().first)
        #expect(got.id == "a")
        #expect(got.state == .transferring)
    }

    @Test func listsNewestFirst() throws {
        let j = try tempJournal()
        try j.addRestore(row("old", at: 100))
        try j.addRestore(row("new", at: 300))
        try j.addRestore(row("mid", at: 200))
        #expect(try j.listRestores().map(\.id) == ["new", "mid", "old"])
    }

    // MARK: - what the run loop picks up

    /// `activeRestores` is the run loop's work list. A finished transfer must fall out of it, or the daemon
    /// would keep re-thawing a file it already delivered — at our expense.
    @Test func activeExcludesFinishedTransfers() throws {
        let j = try tempJournal()
        try j.addRestore(row("waiting", state: .pending, at: 100))
        try j.addRestore(row("moving", state: .transferring, at: 200))
        try j.addRestore(row("unpaid", state: .needsAuthorization, at: 300))
        try j.addRestore(row("done", state: .saved, at: 400))
        try j.addRestore(row("stopped", state: .canceled, at: 500))
        try j.addRestore(row("broken", state: .failed, at: 600))

        // Oldest first — the longest-waiting transfer is served first.
        #expect(try j.activeRestores().map(\.id) == ["waiting", "moving", "unpaid"])
    }

    // MARK: - transitions

    /// `readyAt` marks when the 5-day download window opened, and a free resume is decided from it. A later
    /// state change must not quietly erase it, or a user who stops a paid transfer gets charged to restart it.
    @Test func advancingStateKeepsReadyAt() throws {
        let j = try tempJournal()
        try j.addRestore(row("a", state: .pending))

        try j.setRestoreState("a", .transferring, readyAt: 5_000)
        #expect(try j.restore(id: "a")?.readyAt == 5_000)

        // No readyAt passed — must leave the recorded one alone, not null it.
        try j.setRestoreState("a", .saved, completedAt: 6_000)
        let done = try #require(try j.restore(id: "a"))
        #expect(done.state == .saved)
        #expect(done.readyAt == 5_000)
        #expect(done.completedAt == 6_000)
    }

    @Test func failureRecordsItsReason() throws {
        let j = try tempJournal()
        try j.addRestore(row("a"))
        try j.recordRestoreFault("a", .failed, error: "hash check failed")
        let got = try #require(try j.restore(id: "a"))
        #expect(got.state == .failed)
        #expect(got.error == "hash check failed")
    }

    /// A TRANSIENT fault leaves the transfer where it was so the run loop keeps retrying — only the reason
    /// is recorded. Marking every fault terminal is how a network blip strands a paid-for transfer.
    @Test func aTransientFaultRecordsTheReasonWithoutKillingTheTransfer() throws {
        let j = try tempJournal()
        try j.addRestore(row("a", state: .pending))
        try j.recordRestoreFault("a", .pending, error: "S3 RequestTimeout")
        let got = try #require(try j.restore(id: "a"))
        #expect(got.state == .pending)
        #expect(got.state.isActive, "a transient fault must leave the transfer in the run loop's work list")
        #expect(got.error == "S3 RequestTimeout")
    }

    /// ...and the moment a step succeeds, that reason is history. Leaving it behind would pin a stale
    /// "we hit a snag" note on a transfer that has since recovered.
    @Test func aSuccessfulStepClearsAStaleFault() throws {
        let j = try tempJournal()
        try j.addRestore(row("a", state: .pending))
        try j.recordRestoreFault("a", .pending, error: "S3 RequestTimeout")

        try j.setRestoreState("a", .transferring, readyAt: 5_000)
        let got = try #require(try j.restore(id: "a"))
        #expect(got.error == nil, "a recovered transfer must not still be showing the old fault")
        #expect(got.readyAt == 5_000)      // ...while still not clobbering what a success DOES set
    }

    /// Reopening clears the stale failure but KEEPS `readyAt` — the blob is still warm, and that fact is
    /// exactly what makes the retry free.
    @Test func reopenClearsErrorButKeepsWindow() throws {
        let j = try tempJournal()
        try j.addRestore(row("a", state: .pending))
        try j.setRestoreState("a", .transferring, readyAt: 5_000)
        try j.recordRestoreFault("a", .failed, error: "network died")

        try j.reopenRestore("a", .pending)
        let got = try #require(try j.restore(id: "a"))
        #expect(got.state == .pending)
        #expect(got.error == nil)
        #expect(got.completedAt == nil)
        #expect(got.readyAt == 5_000)     // the window survives — this is what keeps the resume free
    }

    /// **A stopped transfer stays stopped.** `restorePass` snapshots its work list and then awaits S3 for
    /// each row, so a Stop can land while a pass is mid-flight; when that pass resumes it still holds the
    /// old conclusion and writes it. Guarding the write at the SQL level (rather than asking every caller to
    /// re-check) is what makes "Stop actually stops" structural — without it, pressing Stop during a pass
    /// silently un-cancels itself and the transfer carries on.
    @Test func aFinishedTransferCannotBeReanimatedByAnInFlightPass() throws {
        let j = try tempJournal()
        try j.addRestore(row("a", state: .pending))
        try j.setRestoreState("a", .canceled)          // the user pressed Stop

        // ...and now the pass that was already running writes what it concluded a moment ago.
        try j.setRestoreState("a", .transferring, readyAt: 5_000)
        try j.recordRestoreFault("a", .failed, error: "late fault from the same pass")

        let got = try #require(try j.restore(id: "a"))
        #expect(got.state == .canceled, "a stale pass must not revive a transfer the user stopped")
        #expect(got.readyAt == nil)
        #expect(got.error == nil)
    }

    /// The deliberate revival is exempt — that's the whole job of `reopenRestore`, and it is only ever
    /// reached by the user pressing Pick back up.
    @Test func reopenIsTheOneWayBackFromStopped() throws {
        let j = try tempJournal()
        try j.addRestore(row("a", state: .pending))
        try j.setRestoreState("a", .canceled)
        try j.reopenRestore("a", .pending)
        #expect(try j.restore(id: "a")?.state == .pending)
    }

    @Test func deleteRemovesOnlyThatRow() throws {
        let j = try tempJournal()
        try j.addRestore(row("a", at: 100))
        try j.addRestore(row("b", at: 200))
        try j.deleteRestore("a")
        #expect(try j.listRestores().map(\.id) == ["b"])
        #expect(try j.restore(id: "a") == nil)
    }

    // MARK: - dogfood mode

    @Test func jobIdIsOptionalForSelfThawedRestores() throws {
        let j = try tempJournal()
        try j.addRestore(row("a", jobId: nil))     // dogfood: no backend, no money, no job
        #expect(try j.restore(id: "a")?.jobId == nil)
    }
}

/// The two pure rules the app must never re-derive for itself: which transfers are still working, and
/// which stopped ones can be picked back up **without paying again**. Getting the second wrong charges a
/// real person twice for the same bytes, so it lives in one tested place.
@Suite struct RestoreStateTests {
    private func row(state: RestoreState, readyAt: Int?) -> RestoreRow {
        RestoreRow(id: "r", fileId: "f", out: "/tmp/f", jobId: "job", state: state,
                   tier: .bulk, bytes: 1, requestedAt: 0, readyAt: readyAt)
    }

    @Test func activeStatesAreTheUnfinishedOnes() {
        #expect(RestoreState.needsAuthorization.isActive)
        #expect(RestoreState.pending.isActive)
        #expect(RestoreState.transferring.isActive)
        #expect(!RestoreState.saved.isActive)
        #expect(!RestoreState.canceled.isActive)
        #expect(!RestoreState.failed.isActive)
    }

    /// Inside the 5-day thaw window the blobs are still warm, so resuming costs nothing.
    @Test func stoppedTransferResumesFreeInsideTheWindow() {
        let readyAt = 1_000_000
        let r = row(state: .canceled, readyAt: readyAt)
        #expect(r.isResumable(now: readyAt + 60))                          // a minute later
        #expect(r.isResumable(now: readyAt + RestoreRow.thawWindowSeconds - 1))
    }

    /// Past the window the copy has refrozen. Resuming is a genuinely new retrieval — and correctly a new
    /// charge — so this must report false rather than promise a free resume we can't deliver.
    @Test func lapsedWindowIsNotFreeToResume() {
        let readyAt = 1_000_000
        let r = row(state: .canceled, readyAt: readyAt)
        #expect(!r.isResumable(now: readyAt + RestoreRow.thawWindowSeconds))
        #expect(!r.isResumable(now: readyAt + RestoreRow.thawWindowSeconds + 10_000))
    }

    /// Cancelled before the thaw ever landed: nothing was warmed, so there is nothing to resume onto.
    @Test func neverThawedIsNotResumable() {
        #expect(!row(state: .canceled, readyAt: nil).isResumable(now: 9_999_999))
        #expect(!row(state: .failed, readyAt: nil).isResumable(now: 9_999_999))
    }

    /// "Resume" is only ever offered on a STOPPED transfer. A live one is already moving, and a delivered
    /// one has nothing left to do.
    @Test func liveAndFinishedTransfersAreNotResumable() {
        let now = 1_000_500
        for state: RestoreState in [.needsAuthorization, .pending, .transferring, .saved] {
            #expect(!row(state: state, readyAt: 1_000_000).isResumable(now: now))
        }
    }
}
