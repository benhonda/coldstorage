import Testing
@testable import ColdStorageCore

/// The classifier is the SSOT that decides whether a failed blob is worth re-attempting (transient) or
/// should be surfaced + skipped (permanent — config/logic that won't self-heal). Pure, no network.
@Suite struct FailureClassificationTests {
    @Test func permanentS3CodesAreTerminal() {
        for code in ["InvalidStorageClass", "AccessDenied", "NoSuchBucket", "SignatureDoesNotMatch"] {
            #expect(FailureKind.classify(s3Code: code).isPermanent, "\(code) should be permanent")
        }
    }

    @Test func unknownS3CodesAreTransient() {
        // throttling / 5xx that escaped the SDK's own retry — worth another pass later, not terminal.
        for code in ["SlowDown", "RequestTimeout", "InternalError", "ServiceUnavailable", "MadeUpCode"] {
            #expect(!FailureKind.classify(s3Code: code).isPermanent, "\(code) should be transient")
        }
    }

    @Test func ourErrorsArePermanent() {
        // integrity = corruption/hash mismatch; staging/s3 = our precondition or config — none self-heal.
        #expect(FailureKind.classify(ColdStorageError.integrity("hash mismatch")).isPermanent)
        #expect(FailureKind.classify(ColdStorageError.invalidRequest("InvalidStorageClass")).isPermanent)
        #expect(FailureKind.classify(ColdStorageError.s3("createMultipartUpload returned no uploadId")).isPermanent)
    }

    @Test func unknownErrorsDefaultTransient() {
        struct SomeOtherError: Error {}   // optimistic default — don't permanently give up on the unrecognized.
        #expect(!FailureKind.classify(SomeOtherError()).isPermanent)
    }

    @Test func messageSurfacesTheReason() {
        // The message becomes the operator-facing `blobFailed` event payload — it must name the fault.
        #expect(FailureKind.classify(s3Code: "AccessDenied").message.contains("AccessDenied"))
        #expect(FailureKind.classify(ColdStorageError.integrity("hash mismatch")).message.contains("hash mismatch"))
    }
}
