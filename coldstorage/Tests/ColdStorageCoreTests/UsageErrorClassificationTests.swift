import Foundation
import Testing
import AWSCognitoIdentity
import protocol ClientRuntime.ServiceError
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
        // Clock skew right after wake, before NTP resync — S3 answers 403 RequestTimeTooSkewed and the
        // clock fixes itself moments later. Shaped like the SDK's UnknownAWSHTTPServiceError (ServiceError
        // with a typeName) — that type is @_spi-gated, so a stub stands in.
        #expect(DaemonService.isSelfHealingUsageError(StubServiceError(typeName: "RequestTimeTooSkewed")))
        #expect(DaemonService.isSelfHealingUsageError(StubServiceError(typeName: "RequestExpired")))
        #expect(DaemonService.isSelfHealingUsageError(StubServiceError(typeName: "RequestInTheFuture")))
    }

    @Test func realFaultsStillSurface() {
        // AccessDenied/config/logic errors won't fix themselves — the toast must still happen.
        #expect(!DaemonService.isSelfHealingUsageError(ColdStorageError.s3("AccessDenied")))
        #expect(!DaemonService.isSelfHealingUsageError(StubServiceError(typeName: "AccessDenied")))
        struct SomeOtherError: Error {}
        #expect(!DaemonService.isSelfHealingUsageError(SomeOtherError()))
    }
}

private struct StubServiceError: ServiceError, Error {
    let typeName: String?
    var message: String?
    init(typeName: String) { self.typeName = typeName }
}
