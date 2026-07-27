import Testing
@testable import ColdStorageCore

/// The thaw decision is pure (HeadObject storage class + `x-amz-restore` header → state), so it's
/// fully unit-testable without a live S3 — covering the Deep Archive states only real AWS can exercise.
@Suite struct ThawStateTests {
    @Test func directClassesServeImmediately() {
        #expect(ThawState.from(storageClassRaw: nil, restoreHeader: nil) == .ready)          // STANDARD (no header)
        #expect(ThawState.from(storageClassRaw: "STANDARD", restoreHeader: nil) == .ready)
        #expect(ThawState.from(storageClassRaw: "GLACIER_IR", restoreHeader: nil) == .ready) // instant retrieval
    }

    @Test func archivedNotYetRequested() {
        #expect(ThawState.from(storageClassRaw: "DEEP_ARCHIVE", restoreHeader: nil) == .needed)
        #expect(ThawState.from(storageClassRaw: "GLACIER", restoreHeader: nil) == .needed)
    }

    @Test func thawInProgress() {
        #expect(ThawState.from(storageClassRaw: "DEEP_ARCHIVE", restoreHeader: "ongoing-request=\"true\"") == .inProgress)
    }

    @Test func thawComplete() {
        let ready = "ongoing-request=\"false\", expiry-date=\"Fri, 21 Dec 2012 00:00:00 GMT\""
        #expect(ThawState.from(storageClassRaw: "DEEP_ARCHIVE", restoreHeader: ready) == .ready)
    }

    @Test func tierWaitsAreSane() {
        #expect(RestoreTier(rawValue: "standard") == .standard)
        #expect(RestoreTier(rawValue: "turbo") == nil)
        #expect(RestoreTier.bulk.typicalWait.contains("48"))
    }

    /// The prose and the number are one fact in two forms — the app puts a countdown directly above a
    /// sentence quoting the wait, so a tier whose two halves disagree is visible on screen. `typicalWait`
    /// derives from `typicalWaitSeconds` for exactly this reason; this pins that they stay in step for
    /// every tier that quotes an hour count.
    @Test func theWaitReadsTheSameInBothForms() {
        for tier in [RestoreTier.standard, .bulk] {
            #expect(tier.typicalWait == "~\(tier.typicalWaitSeconds / 3600) hours")
        }
        // Expedited is the deliberate exception: it isn't a Deep Archive option, so its string carries the
        // caveat rather than an hour count. It still owes a sane number for anything doing arithmetic.
        #expect(RestoreTier.expedited.typicalWait.contains("not Deep Archive"))
        #expect(RestoreTier.expedited.typicalWaitSeconds > 0)
    }
}
