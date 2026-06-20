import XCTest
@testable import ColdStorageCore

/// The thaw decision is pure (HeadObject storage class + `x-amz-restore` header → state), so it's
/// fully unit-testable without a live S3 — covering the Deep Archive states we can't exercise vs MinIO.
final class ThawStateTests: XCTestCase {
    func testDirectClassesServeImmediately() {
        XCTAssertEqual(.ready, ThawState.from(storageClassRaw: nil, restoreHeader: nil))              // STANDARD/MinIO (no header)
        XCTAssertEqual(.ready, ThawState.from(storageClassRaw: "STANDARD", restoreHeader: nil))
        XCTAssertEqual(.ready, ThawState.from(storageClassRaw: "GLACIER_IR", restoreHeader: nil))     // instant retrieval
    }

    func testArchivedNotYetRequested() {
        XCTAssertEqual(.needed, ThawState.from(storageClassRaw: "DEEP_ARCHIVE", restoreHeader: nil))
        XCTAssertEqual(.needed, ThawState.from(storageClassRaw: "GLACIER", restoreHeader: nil))
    }

    func testThawInProgress() {
        XCTAssertEqual(.inProgress, ThawState.from(storageClassRaw: "DEEP_ARCHIVE",
                                                   restoreHeader: "ongoing-request=\"true\""))
    }

    func testThawComplete() {
        let ready = "ongoing-request=\"false\", expiry-date=\"Fri, 21 Dec 2012 00:00:00 GMT\""
        XCTAssertEqual(.ready, ThawState.from(storageClassRaw: "DEEP_ARCHIVE", restoreHeader: ready))
    }

    func testTierWaitsAreSane() {
        XCTAssertEqual(.standard, RestoreTier(rawValue: "standard"))
        XCTAssertNil(RestoreTier(rawValue: "turbo"))
        XCTAssertTrue(RestoreTier.bulk.typicalWait.contains("48"))
    }
}
