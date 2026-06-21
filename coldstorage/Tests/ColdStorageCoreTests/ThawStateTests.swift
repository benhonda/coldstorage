import Testing
@testable import ColdStorageCore

/// The thaw decision is pure (HeadObject storage class + `x-amz-restore` header → state), so it's
/// fully unit-testable without a live S3 — covering the Deep Archive states we can't exercise vs MinIO.
@Suite struct ThawStateTests {
    @Test func directClassesServeImmediately() {
        #expect(ThawState.from(storageClassRaw: nil, restoreHeader: nil) == .ready)          // STANDARD/MinIO (no header)
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
}
