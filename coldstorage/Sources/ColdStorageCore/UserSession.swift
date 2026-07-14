import Foundation
import Crypto

/// Who the daemon is currently acting as.
///
/// `sub` (the Cognito **User Pool** subject) is the canonical identity throughout ColdStorage — the app's
/// key escrow is keyed by it, the account backend authorizes by it. `identityId` (the **Identity Pool**
/// id) is a *derived storage-addressing detail*: it is what AWS substitutes into the IAM policy variable,
/// so it names the S3 prefix and nothing else. Keeping the distinction explicit is the point — conflating
/// the two is how this codebase ended up with four different answers to "who is the current user".
public enum SessionIdentity: Sendable, Equatable {
    case user(sub: String, identityId: String)
    /// Local development only (MinIO / no Cognito), and only via an explicit `COLDSTORE_DEV_IDENTITY`.
    case dev(name: String)

    /// The directory name this identity's state lives under. Named for `sub` — see the type doc.
    var directoryName: String {
        switch self {
        case .user(let sub, _): return sub
        case .dev(let name): return "dev-\(name)"
        }
    }

    var vaultPrefix: VaultPrefix {
        switch self {
        case .user(_, let identityId): return .user(identityId: identityId)
        case .dev: return .dev
        }
    }
}

/// **Everything that belongs to the signed-in user, and the only way to reach any of it.**
///
/// This type exists because of a real cross-account leak (2026-07-13): the journal was a single
/// machine-wide SQLite file with no owner column, so signing out and signing in as a second account on the
/// same Mac showed that account the first one's entire file tree. The credentials, the encryption key, and
/// the S3 prefix had all been made per-user as multi-user support landed; the journal, the scratch dir and
/// `status.json` were simply never brought along, because nothing forced them to be.
///
/// The fix is structural, not a patch. `DaemonService` holds no journal, no engine, and no key of its own —
/// it holds an *optional session*. Signed out, there is nothing to read; signed in, everything reachable is
/// already scoped to exactly one user. A future subsystem cannot forget to scope itself, because there is
/// no unscoped thing for it to reach for. That's PILLAR4 doing the work instead of the next author's memory.
///
/// Layout on disk (`<dataRoot>/users/<sub>/`):
///   - `coldstore.sqlite` — the journal (file index, watched-folder registry, excludes)
///   - `scratch/`         — where a PUSH source (PhotoKit) materializes an asset while it streams. **Per-user
///                          because it holds plaintext bytes.** The upload engine writes nothing here — it
///                          encrypts straight into the multipart parts. Swept when the session is built.
///   - `status.json`      — the run summary this user's app reads
///
/// One-way: a session is CONSTRUCTED at `authenticate` and DESTROYED at `deauthenticate`. It is never
/// mutated to point at a different user — a different user means a different session.
public final class UserSession: @unchecked Sendable {
    public let identity: SessionIdentity
    /// Where this user's blobs live in S3. Typed, so the listing-vs-key slash can't be got wrong again.
    public let prefix: VaultPrefix
    public let dir: URL
    /// Scratch for a source that can only PUSH its bytes at us — today, a Photos asset PhotoKit is streaming
    /// (`scratchFileStream`). The upload engine itself writes nothing: it encrypts straight into the multipart
    /// parts. **Per-user because these are plaintext bytes**, and swept when the session is built — nothing in
    /// here survives a restart by design.
    public let scratchDir: URL
    public let journal: Journal
    /// The MasterKey holder. Starts LOCKED for a real user (the app sends the MK via `mintVault` /
    /// `unlockVault*`); a dev session is seeded from the local file KEK so MinIO runs need no unlock step.
    public let vaultKey: SwappableKeyProvider
    public let engine: UploadEngine
    public let restoreEngine: RestoreEngine
    public let statusPath: String

    /// `initialKey` non-nil ⇒ dev mode (seeded, immediately usable). Real users start locked.
    /// `canSelfThaw` mirrors what these credentials can actually DO: a dev/dogfood IAM user holds
    /// `s3:RestoreObject`; a customer's Cognito role deliberately does not (the paid-retrieval gate).
    public init(identity: SessionIdentity, dataRoot: URL, store: any Vault,
                canSelfThaw: Bool, initialKey: SymmetricKey? = nil) throws {
        self.identity = identity
        self.prefix = identity.vaultPrefix
        self.dir = dataRoot.appendingPathComponent("users", isDirectory: true)
                           .appendingPathComponent(identity.directoryName, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        self.scratchDir = dir.appendingPathComponent("scratch", isDirectory: true)
        try FileManager.default.createDirectory(at: scratchDir, withIntermediateDirectories: true)
        // Building a session means this user has nothing in flight yet — so anything still in here is debris
        // from a killed deposit, and this is the one moment it can be cleared without racing a live one.
        sweepScratch(scratchDir)

        self.journal = try Journal(path: dir.appendingPathComponent("coldstore.sqlite").path)
        self.vaultKey = SwappableKeyProvider(initial: initialKey)
        self.statusPath = dir.appendingPathComponent("status.json").path
        self.engine = UploadEngine(journal: journal, store: store, keys: vaultKey)
        self.restoreEngine = RestoreEngine(journal: journal, store: store, keys: vaultKey,
                                           canSelfThaw: canSelfThaw)
    }

    /// True when this session belongs to the given user-pool subject — the check `authenticate` uses to
    /// stay idempotent across hourly token refreshes (same `sub` ⇒ keep the open journal and the unlocked
    /// MasterKey; a *different* `sub` ⇒ tear this session down and build a new one).
    func belongs(toSub sub: String) -> Bool {
        if case .user(let s, _) = identity { return s == sub }
        return false
    }

    /// Drop the MasterKey. Called on sign-out before the session is released, so the key never outlives the
    /// session even if something else is briefly holding a reference to it.
    func close() {
        vaultKey.clear()
    }
}

/// Builds sessions. Holds the process-wide things a session needs but does not own — the data root, the
/// shared S3 store (its credentials are re-pointed per-user by `CognitoAuth`'s resolver), and whether this
/// daemon's credentials may thaw. Injected into `DaemonService` so tests can build sessions against a
/// temp dir and a fake store.
public struct SessionFactory: Sendable {
    let dataRoot: URL
    let store: any Vault
    let canSelfThaw: Bool

    public init(dataRoot: URL, store: any Vault, canSelfThaw: Bool) {
        self.dataRoot = dataRoot; self.store = store; self.canSelfThaw = canSelfThaw
    }

    public func make(_ identity: SessionIdentity, initialKey: SymmetricKey? = nil) throws -> UserSession {
        try UserSession(identity: identity, dataRoot: dataRoot, store: store,
                        canSelfThaw: canSelfThaw, initialKey: initialKey)
    }
}
