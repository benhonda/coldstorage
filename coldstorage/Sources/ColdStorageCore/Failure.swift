import Foundation
import AWSClientRuntime   // AWSServiceError.errorCode — to read the S3 error code

/// How to react to a failure (graceful error handling, design §error-handling). The AWS SDK already
/// retries *transient* faults (throttling/5xx/timeouts) with backoff before they ever reach us, so by
/// the time an error surfaces here the decision is: is it worth another pass *later* (transient — a
/// network window that's since closed), or is it a config/logic fault that won't fix itself (permanent
/// — e.g. the `InvalidStorageClass` fatal, `AccessDenied`, a hash mismatch)? We isolate the blob either
/// way; `permanent` additionally tells the daemon to stop re-staging+re-attempting a doomed blob.
public enum FailureKind: Sendable, Equatable {
    case transient(String)
    case permanent(String)
    /// The vault is full: this blob was REFUSED before upload because storing it would cross the user's
    /// quota (`UploadEngine` enforces it — the one place the periodic auto-run can't slip past). Not the
    /// blob's fault and not doomed: it retries the moment there's room (a plan change, or freed space), so
    /// it is NOT permanent. Distinct from `transient` so the daemon can flag it on the wire and the UI can
    /// upsell (show the plan picker) instead of a generic ⚠.
    case overQuota(String)

    public var message: String { switch self { case .transient(let m), .permanent(let m), .overQuota(let m): return m } }
    public var isPermanent: Bool { if case .permanent = self { return true }; return false }
    public var isOverQuota: Bool { if case .overQuota = self { return true }; return false }

    /// The kind as it travels on the `blobFailed` event, so the UI can tell an out-of-room refusal from a
    /// real fault. One SSOT for the wire spelling.
    public var wireKind: String {
        switch self { case .permanent: return "permanent"; case .transient: return "transient"; case .overQuota: return "overQuota" }
    }

    /// S3/Glacier error codes that won't self-heal — re-attempting just burns cycles. Conservative on
    /// purpose: anything *not* listed defaults to `.transient` (keep trying) rather than silently giving
    /// up on something recoverable. SSOT for the permanent set.
    static let permanentS3Codes: Set<String> = [
        "InvalidStorageClass", "AccessDenied", "AllAccessDisabled", "NoSuchBucket", "NoSuchUpload",
        "InvalidAccessKeyId", "SignatureDoesNotMatch", "AuthorizationHeaderMalformed", "InvalidArgument",
        "InvalidRequest", "MalformedXML", "EntityTooLarge", "KMS.DisabledException", "KMS.AccessDeniedException",
    ]

    /// Pure code → kind (unit-testable without constructing SDK error values).
    public static func classify(s3Code code: String) -> FailureKind {
        permanentS3Codes.contains(code)
            ? .permanent("S3 \(code)")
            : .transient("S3 \(code)")
    }

    /// Classify an arbitrary thrown error. Our own `ColdStorageError`s are config/data faults (permanent);
    /// SDK service errors map by code; anything else is treated as transient (optimistic — retry next pass).
    public static func classify(_ error: Error) -> FailureKind {
        switch error {
        case let e as ColdStorageError:
            // integrity = corruption/hash mismatch; s3/staging = our precondition or config — none self-heal.
            return .permanent("\(e)")
        case let e as AWSServiceError where e.errorCode != nil:
            let code = e.errorCode!
            return permanentS3Codes.contains(code) ? .permanent("S3 \(code): \(e)") : .transient("S3 \(code): \(e)")
        default:
            return .transient("\(error)")
        }
    }
}

/// One blob that failed to archive this pass, with why. The engine returns these instead of aborting the
/// whole run — a single poison blob must not block the rest of the backup.
public struct BlobFailure: Sendable, Equatable {
    /// A logical file caught in a failed blob — its journal `id` (to mark it `failed`) and `path` (to name
    /// it on the wire / match the user's row). Both are needed because they diverge for Photos (id =
    /// localIdentifier ≠ relativePath), and the optimistic UI row keys on path while the journal keys on id.
    public struct File: Sendable, Equatable {
        public let id: String
        public let path: String
        public init(id: String, path: String) { self.id = id; self.path = path }
    }
    public let blobId: String
    public let kind: FailureKind
    /// The files batched into this blob. Surfaced so the daemon can mark them `failed` in the journal
    /// (permanent only) and name them on the `blobFailed` event — making the UI's ⚠ row journal truth, not a
    /// UI guess. Defaulted so existing call sites/tests that don't care stay terse.
    public let files: [File]
    public init(blobId: String, kind: FailureKind, files: [File] = []) {
        self.blobId = blobId; self.kind = kind; self.files = files
    }
}
