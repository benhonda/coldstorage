import Foundation
import AWSClientRuntime   // AWSServiceError.errorCode — to read the S3 error code

/// WHY a file is `failed` — a closed set the app turns into words, and the ONLY thing it turns into words.
/// The journal used to hold the user-facing sentence itself (`files.error`), which made copy a persisted
/// fact: a row written by last month's build kept last month's wording forever, and one cause fragmented
/// into as many "reasons" as there had been phrasings of it. Now the row carries the KIND; the app owns the
/// sentence; `files.error` keeps the developer-facing detail (an S3 code, a thrown message) for Get info.
/// `Codable` as its raw string — the wire spelling the app's `FileFailureKind` mirrors.
public enum FileFailureKind: String, Codable, Sendable {
    /// A fault that won't self-heal — access denied, a bad hash, an unsupported storage class.
    case permanent
    /// Refused before upload: storing it would cross the vault's quota. Retries once there's room.
    case overQuota
    /// The user pressed Stop before this landed. Not a fault; the next pass or a retry finishes it.
    case stopped
    /// "Try again" could not find the bytes: no recorded source, or the path isn't on disk right now.
    case missingSource
    /// Nothing is driving this upload any more — the daemon died mid-drop on a build that had no durable
    /// deposit to replay, or the folder that owned it was unwatched. The bytes never landed.
    case interrupted
}

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
    /// The user pressed Stop (`cancelRun`) before this blob landed — either mid-stream or never started.
    /// Not a fault at all: nothing is wrong with the blob, the bytes, or the link. It exists as a failure
    /// kind so the SAME path that marks a refused blob's files (`markFilesFailed`) gives these files honest
    /// journal truth — a row that says "stopped" rather than "uploading" for something nobody is uploading.
    /// Retryable by re-dropping (ad-hoc deposit) or on the next pass (watched folder), exactly like `overQuota`.
    case stopped(String)

    public var message: String { switch self { case .transient(let m), .permanent(let m), .overQuota(let m), .stopped(let m): return m } }
    public var isPermanent: Bool { if case .permanent = self { return true }; return false }
    public var isOverQuota: Bool { if case .overQuota = self { return true }; return false }
    public var isStopped: Bool { if case .stopped = self { return true }; return false }

    /// The kind as it travels on the `blobFailed` event, so the UI can tell an out-of-room refusal from a
    /// real fault. One SSOT for the wire spelling.
    public var wireKind: String {
        switch self {
        case .permanent: return "permanent"; case .transient: return "transient"
        case .overQuota: return "overQuota"; case .stopped: return "stopped"
        }
    }

    /// The one wording for a user-stopped upload, wherever it surfaces (journal `error`, log, wire).
    public static let stoppedMessage = "Stopped before it finished uploading."

    /// The `FileFailureKind` a blob failure of this kind writes onto its files — nil for transient, which
    /// never marks a file `failed` (it stays queued and retries next pass).
    public var fileFailureKind: FileFailureKind? {
        switch self {
        case .permanent: return .permanent; case .overQuota: return .overQuota
        case .stopped: return .stopped; case .transient: return nil
        }
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
        // The run was cancelled (`cancelRun`) while this blob was streaming. Not a fault — see `.stopped`.
        case is CancellationError:
            return .stopped(stoppedMessage)
        // A truncated ranged read is the one ColdStorageError that names a NETWORK fault, not a
        // config/data one — a rerun redownloads and succeeds, so condemning it would strand a paid
        // transfer over a dropped connection (see the case's own doc).
        case ColdStorageError.shortRead(let m):
            return .transient(m)
        // A watched folder we can't read is almost always an unplugged drive — it heals when it's plugged
        // back in, so retrying is exactly right. The OTHER `ColdStorageError`s are config/data faults, hence
        // the explicit case rather than letting the blanket rule below condemn this one.
        case ColdStorageError.sourceUnreadable(let m):
            return .transient(m)
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
