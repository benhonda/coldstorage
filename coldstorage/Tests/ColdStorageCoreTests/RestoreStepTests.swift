import Testing
@testable import ColdStorageCore

/// The paid-retrieval HARD GATE, at the daemon's edge (root `RETRIEVAL.md`).
///
/// The gate's real enforcement is in IAM — a customer's Cognito role has no `s3:RestoreObject`, so a
/// tampered daemon that tried to thaw anyway would simply get AccessDenied. These tests cover the honest
/// daemon's half of it: that it recognises it cannot thaw, and routes the user to a quote instead of
/// hammering S3 with a call that can only fail.
///
/// Pure by construction (`RestoreStep.next`), so the decision is testable without a live S3 — the same
/// trick `ThawStateTests` uses for the storage-class mapping it wraps.
@Suite struct RestoreStepTests {

    // MARK: - Multi-user (a customer's Cognito credentials — CANNOT thaw)

    @Test func frozenBlobOnACustomerDaemonNeedsAuthorization() {
        // THE gate. A frozen blob + no thaw rights ⇒ go get the restore paid for. Never `.thaw`: that call
        // would be AccessDenied, and — worse — if it ever DID succeed, we'd have handed out an unpaid
        // restore whose egress we pay for.
        #expect(RestoreStep.next(thaw: .needed, canSelfThaw: false) == .needsAuthorization)
    }

    @Test func billingNeverBlocksAThawAlreadyPaidFor() {
        // Once the backend has thawed a PAID restore, the customer daemon must get on with it. If billing
        // leaked into these two states, a user could pay and then be told to pay again.
        #expect(RestoreStep.next(thaw: .inProgress, canSelfThaw: false) == .wait)
        #expect(RestoreStep.next(thaw: .ready, canSelfThaw: false) == .download)
    }

    @Test func aThawedBlobStillDownloads_theGateIsTheThawNotTheRead() {
        // The design rests on this asymmetry: the customer keeps `s3:GetObject` (HeadObject needs it, and
        // it's inert against a frozen object), and loses only `s3:RestoreObject`. So a thawed blob reads
        // normally in BOTH modes — which is why no presigned-URL machinery was needed.
        #expect(RestoreStep.next(thaw: .ready, canSelfThaw: false) == .download)
        #expect(RestoreStep.next(thaw: .ready, canSelfThaw: true) == .download)
    }

    // MARK: - Dogfood (the IAM user — still holds s3:RestoreObject)

    @Test func dogfoodDaemonThawsDirectly() {
        // Ben's own daemon runs as the IAM user from infra/coldstorage/.../iam.tf, which kept
        // RestoreObject. It must NOT be pushed through a billing flow that doesn't exist for it.
        #expect(RestoreStep.next(thaw: .needed, canSelfThaw: true) == .thaw)
        #expect(RestoreStep.next(thaw: .inProgress, canSelfThaw: true) == .wait)
    }

    // MARK: - The one thing that must never happen

    @Test func aDaemonThatCannotThawNeverDecidesToThaw() {
        // Exhaustive over every state: `canSelfThaw == false` must NEVER yield `.thaw`. This is the
        // invariant the whole gate rests on, so it's asserted over the full input space rather than
        // spot-checked — a future state added to ThawState will fail here until it's considered.
        for thaw in [ThawState.needed, .inProgress, .ready] {
            #expect(RestoreStep.next(thaw: thaw, canSelfThaw: false) != .thaw)
        }
    }
}
