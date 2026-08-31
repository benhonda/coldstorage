import Foundation
import Testing
import AWSCognitoIdentity
@testable import ColdStorageCore

/// The usage-refresh toast gate: wake-from-sleep transients (offline, a token the app is about to
/// re-mint, our own listing timeout) stay in the err log; everything else still reaches the UI verbatim.
@Suite struct UsageErrorClassificationTests {
    @Test func wakeFromSleepTransientsAreSelfHealing() {
        #expect(DaemonService.isSelfHealingUsageError(TimedOutError()))
        #expect(DaemonService.isSelfHealingUsageError(NotAuthorizedException(message: "Token is inactive")))
        #if canImport(Darwin)
        // The exact toast from the field: NSURLErrorDomain -1009 after opening the lid, network not back.
        let offline = NSError(domain: NSURLErrorDomain, code: NSURLErrorNotConnectedToInternet)
        #expect(DaemonService.isSelfHealingUsageError(offline))
        #endif
    }

    @Test func realFaultsStillSurface() {
        // AccessDenied/config/logic errors won't fix themselves — the toast must still happen.
        #expect(!DaemonService.isSelfHealingUsageError(ColdStorageError.s3("AccessDenied")))
        struct SomeOtherError: Error {}
        #expect(!DaemonService.isSelfHealingUsageError(SomeOtherError()))
    }
}
