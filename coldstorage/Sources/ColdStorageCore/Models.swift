import Foundation

/// **What the scan knows about an item's content — and, crucially, whether it can be CHECKED.**
///
/// One field, not two, and that is the whole point. This started as `contentHash: String` plus an
/// `expectedSha256: String?`, which for every file source meant assigning the same string to both — two
/// fields obliged to agree, with nothing making them. A source could set the plan key to one value and the
/// verifiable hash to another and no type would object. Here, desynchronisation is unrepresentable.
public enum ContentKey: Sendable, Equatable {
    /// The plaintext SHA-256, measured during the walk. The archive re-computes it from the bytes it actually
    /// uploads and refuses to store them if they differ (`UploadEngine`'s drift guard).
    case sha256(String)
    /// An identity that is NOT a hash of anything — a Photos `localIdentifier`. The asset's bytes don't exist
    /// until PhotoKit streams them (possibly down from iCloud), so there is nothing to measure ahead of the
    /// read and therefore nothing to check against. Comparing this to real bytes would fail on every photo.
    case opaque(String)

    /// What the PLAN is keyed on: change detection, dedupe, and the content-derived blob id.
    public var planKey: String { switch self { case .sha256(let s), .opaque(let s): return s } }
    /// The hash the archive must reproduce — or `nil` when this source cannot be checked (`.opaque`).
    public var verifiableSha256: String? { if case .sha256(let s) = self { return s }; return nil }
}

/// A single user file/photo to archive, plus the metadata that drives ordering + change detection.
public struct IngestItem: Sendable {
    public let id: String                  // stable key (Photos localIdentifier, or relative path)
    public let relativePath: String
    public let size: Int
    public let content: ContentKey         // the plan's key — and whether the bytes can be checked against it
    public let isFavorite: Bool
    /// Everything about the item that isn't its bytes (dates, mode, flags, xattrs, Photos facts) — journaled,
    /// written into the blob's manifest, put back on restore, and (its `date`) what the planner orders on.
    /// The ONE record of these facts; see `FileMetadata`.
    public let metadata: FileMetadata
    /// Where the bytes come from: an absolute path on THIS Mac, or `photos:<localIdentifier>` for a Photos
    /// asset (see `photoSourcePrefix`), or nil when unknown. Persisted on the journal row (`files.sourcePath`)
    /// so a failed upload can be re-tried from its source long after the deposit that carried it is gone —
    /// the row itself remembers where to look.
    public let sourcePath: String?
    /// The one spelling of a Photos-asset source. A `sourcePath` with this prefix names an asset the
    /// `PhotoResolver` can re-resolve; anything else is a filesystem path.
    public static let photoSourcePrefix = "photos:"
    public static func photoAssetId(fromSource s: String) -> String? {
        s.hasPrefix(photoSourcePrefix) ? String(s.dropFirst(photoSourcePrefix.count)) : nil
    }
    public let open: @Sendable () -> AsyncThrowingStream<Data, Error>  // plaintext byte stream

    public init(id: String, relativePath: String, size: Int, content: ContentKey,
                isFavorite: Bool, metadata: FileMetadata = FileMetadata(), sourcePath: String? = nil,
                open: @escaping @Sendable () -> AsyncThrowingStream<Data, Error>) {
        self.id = id; self.relativePath = relativePath; self.size = size
        self.content = content
        self.isFavorite = isFavorite; self.metadata = metadata; self.sourcePath = sourcePath; self.open = open
    }

    /// A copy re-keyed to a new vault path (path-keyed sources use id == relativePath), preserving the
    /// captured byte stream + intrinsic metadata. Used to "Keep Both" a colliding deposit under a fresh name.
    func rekeyed(to relativePath: String) -> IngestItem {
        IngestItem(id: relativePath, relativePath: relativePath, size: size, content: content,
                   isFavorite: isFavorite, metadata: metadata, sourcePath: sourcePath, open: open)
    }
}

/// A group of items that becomes one S3 object. Small files batched; large files solo.
public struct BlobPlan: Sendable {
    public let id: String
    public let items: [IngestItem]
    /// The S3 key namespace this blob lands under — the per-user prefix the IAM role scopes creds to
    /// (`blobs/${cognito-identity.amazonaws.com:sub}/*`), so user A's creds can't touch user B's objects.
    /// Supplied per-run from the daemon's live session; the content-derived `id` is unchanged by it.
    public let prefix: VaultPrefix
    public init(id: String, items: [IngestItem], prefix: VaultPrefix) {
        self.id = id; self.items = items; self.prefix = prefix
    }
    public var s3Key: String { prefix.key(for: id) }
}

/// A configured ingest source (design §3 `sources` table). Folders carry a `path`; the Photos
/// library is a single platform source with no path. The journal is the SSOT — add/remove flows
/// through IPC into this table, so sources survive daemon restarts.
public enum SourceKind: String, Codable, Sendable { case folder, photos }
/// An explicit deposit — a drop, or a photo pick — recorded BEFORE its run starts and KEPT afterwards as
/// the user's own unit of upload history: "the folder I dropped on Tuesday" is one row here, however many
/// files rode in it. Watched folders are re-scanned every pass, so an interrupted one resumes by itself; a
/// drop had no such anchor: kill the daemon mid-30 GB and its files sat "uploading" in the tree with nobody
/// uploading them, until the user happened to drop the same folder again (2026-08-25). This row is the
/// anchor while `state == .pending` (still owed — the scheduled pass replays it) and the batch's identity
/// once `.done` (every file settled: archived, or failed with nothing left to retry). Files point back at
/// the deposit that last claimed them (`FileRow.depositId`), so a batch's counts are derived from its rows
/// and never stored here — the two can't disagree.
///
/// `src` is absolute paths (`.files`) or Photos localIdentifiers (`.photos`) — or, for a batch the orphan
/// sweep minted to adopt failures nothing owned (`.retry` from birth, never ran as a drop), the vault
/// folders its rows sit in, for display only; `conflicts` and `excludeExtra`
/// are the user's answers at drop time, replayed verbatim so a resumed deposit lands exactly where — and
/// skips exactly what — the original would have. `mode` says how a replay re-reads the bytes: `.ingest`
/// enumerates `src` again (the first run, or one interrupted before it settled); `.retry` re-ingests the
/// deposit's OWN still-owed rows from each row's `sourcePath` — the user's "Try again" on a settled batch,
/// which must finish the failed rows in place (same id, same vault path) rather than re-drop `src` and land
/// a second copy beside every file that was renamed or moved since. A retry is therefore an action ON a
/// deposit — it reopens the same row — never a new one.
public struct Deposit: Sendable, Equatable {
    public enum Kind: String, Sendable { case files, photos }
    public enum State: String, Sendable { case pending, done }
    public enum Mode: String, Sendable { case ingest, retry }
    public let id: String
    public let kind: Kind
    public let src: [String]
    public let dest: String
    public let conflicts: [String: String]
    public let excludeExtra: [String]
    public let createdAt: Int
    public let state: State
    public let mode: Mode
    /// When it last settled (`.done`); nil while owed. Cleared again by a retry, which reopens the row.
    public let finishedAt: Int?
    public init(id: String, kind: Kind, src: [String], dest: String, conflicts: [String: String],
                excludeExtra: [String], createdAt: Int, state: State = .pending, mode: Mode = .ingest,
                finishedAt: Int? = nil) {
        self.id = id; self.kind = kind; self.src = src; self.dest = dest
        self.conflicts = conflicts; self.excludeExtra = excludeExtra; self.createdAt = createdAt
        self.state = state; self.mode = mode; self.finishedAt = finishedAt
    }
}

public struct SourceRow: Sendable {
    public let id: String          // stable key — the absolute path for folders
    public let kind: SourceKind
    public let path: String?
    /// Destination: the vault-relative folder this source's tree mounts under in My Files (e.g.
    /// "Backups/Photos"). The daemon owns this placement — every ingested item is re-based under it, which
    /// both lets the user choose *where* a watched folder lands and namespaces sources so same-named files
    /// across two folders can't collide on `id`. Never empty for a folder (defaults to the basename).
    public let mountPath: String
    /// Per-source pause: when true the scheduled scan loop skips this folder (it stays registered, just
    /// isn't auto-synced). Persistent (journal-backed) so a deliberate pause survives a daemon restart —
    /// unlike the old transient global flag this replaced. Manual deposits are unaffected (always honored).
    public let paused: Bool
    /// When this source was last SCANNED — stamped every pass, success or failure. `nil` until the first
    /// pass touches it. The third of the freshness clocks (`RestoreRow.lastStepAt`, `FileRow.lastAttemptAt`),
    /// and the one guarding the product's core promise: without it, "we are backing this folder up" was an
    /// unfalsifiable claim that survived the folder being unplugged.
    public let lastScanAt: Int?
    /// Why the last scan failed, or nil — an unmounted drive, a deleted folder, a revoked permission.
    /// Cleared the moment a scan succeeds.
    public let error: String?
    public init(id: String, kind: SourceKind, path: String?, mountPath: String = "", paused: Bool = false,
                lastScanAt: Int? = nil, error: String? = nil) {
        self.id = id; self.kind = kind; self.path = path; self.mountPath = mountPath; self.paused = paused
        self.lastScanAt = lastScanAt; self.error = error
    }
}

/// Where one logical file's bytes live inside its blob's ciphertext — measured while sealing, written when
/// the blob is archived. Carried as a value type so the whole blob's links can be committed in one
/// transaction (see `Journal.markBlobArchived`) rather than file-by-file.
public struct FileSpan: Sendable {
    public let id: String
    public let offset: Int
    public let length: Int
    public let firstFrame: Int
    public let plaintextSha256: String
    public let size: Int
    public init(id: String, offset: Int, length: Int, firstFrame: Int, plaintextSha256: String, size: Int) {
        self.id = id; self.offset = offset; self.length = length
        self.firstFrame = firstFrame; self.plaintextSha256 = plaintextSha256; self.size = size
    }
}

/// **There is no `deleted` case, deliberately.** Deletion is a `files.deletedAt` timestamp, ORTHOGONAL to
/// the lifecycle this enum describes — a tombstoned file is still "an archived file", it is just also
/// deleted. It used to be a status, and overloading one column with row-KIND (`folder`), upload LIFECYCLE
/// and DELETEDNESS meant tombstoning destroyed the other two: reviving a row had nothing to restore *to*, so
/// it guessed `discovered`, which turned folder markers into phantom files and stranded them as permanently
/// "uploading" (see `Journal.reviveFiles` and `FolderReviveTests`). Deleting is now non-destructive to state.
///
/// `folder` is a FOLDER MARKER: a path-only row (size 0, no blob) that anchors a just-created EMPTY folder
/// so it survives a reload — otherwise an empty folder, having no files beneath it to imply its path, would
/// vanish (the tree is derived from file paths). The marker is excluded from the file count and never
/// becomes a browsable file; `movePath`/`deletePath` sweep it by path like any other row. Once real files
/// land under the folder the marker is redundant (the path is implied) but harmless — the UI dedups by name.
/// `uploading`/`verifying` are declared but never persisted — the journal only ever writes `planned`,
/// `archived`, `failed` and `folder` (plus `discovered` as the decoder's fallback). They're the
/// hooks for a future per-file progress state. A `staging` case sat here too until the upload engine stopped
/// staging (2026-07-14) — it named a step that no longer exists, so it's gone.
public enum FileStatus: String, Codable, Sendable { case discovered, planned, uploading, verifying, archived, failed, folder }
/// `reaped` = every file in the blob was deleted and the object has been tagged for lifecycle expiry. A
/// terminal state, distinct from `aborted` (which is an upload that never landed): the bytes DID land, were
/// whole, and are now being reclaimed. Kept as a row rather than dropped so a second pass doesn't re-tag it,
/// and so the history of what happened to those bytes survives.
public enum BlobStatus: String, Codable, Sendable { case open, uploading, completed, verified, aborted, reaped }
public enum PartStatus: String, Codable, Sendable { case pending, uploaded, verified }

public enum ColdStorageError: Error, CustomStringConvertible {
    case s3(String), integrity(String)
    /// The caller asked for something impossible or incoherent: not signed in, a missing parameter, no key
    /// material for a blob. (Was `.staging` — a name inherited from the staging step, which no longer exists.)
    case invalidRequest(String)
    /// The daemon lacks (full) Photos access, so a photo deposit can't read the picked assets. Carries a
    /// user-facing, recoverable message — the UI maps this case to an "Open Photos settings" action.
    case photosAccess(String)
    /// A photo deposit resolved ZERO of its picked assets (all stale, or the daemon can't see them) even
    /// though access is granted — so nothing would be archived. Surfaced rather than silently no-op'd.
    case photosNoneResolved(String)
    /// The source changed between the scan that planned this blob and the read that uploaded it — so the
    /// bytes we just encrypted are not the bytes the plan was made from. Fails the blob instead of archiving
    /// a file that never existed. Permanent by classification, and correctly so: the blob id is derived from
    /// the OLD content hash, so *that* blob can never be archived again — the next scan re-hashes the file
    /// and plans it afresh under a new id.
    case contentDrift(String)
    /// A ranged read ended cleanly but EARLY — the store delivered fewer bytes than the span asked for (a
    /// cut connection, a truncated response). Its own case, not `.s3`, because the distinction is what
    /// `FailureKind.classify` keys on: every other `ColdStorageError` is a config/data fault that can't
    /// self-heal (permanent), while this one describes the NETWORK, not the data — the next restore pass
    /// re-runs the download from scratch and succeeds. Folding it into `.s3` permanently stranded a
    /// transfer over one dropped connection.
    case shortRead(String)
    /// A watched folder could not be READ — unmounted external drive, folder deleted or renamed, macOS
    /// permission revoked. Its own case because the alternative was catastrophic and silent: the walk
    /// returned an empty array, which is indistinguishable from "the folder is fine and has nothing new",
    /// so a backup that had stopped happening reported "nothing new to archive" every five minutes forever.
    ///
    /// TRANSIENT by classification (it isn't in `permanentS3Codes`, and the default is transient), which is
    /// the right call: the overwhelmingly common cause is a drive that will be plugged back in, and the next
    /// pass should simply try again. `ScanReportingSource` keeps one bad folder from aborting the others.
    case sourceUnreadable(String)
    /// The bare message — so `"\(error)"` (CLI stderr, daemon wire `error` field) reads cleanly instead
    /// of leaking the case name (`invalidRequest("…")`).
    public var description: String {
        switch self {
        case .s3(let m), .integrity(let m), .invalidRequest(let m), .photosAccess(let m),
             .photosNoneResolved(let m), .contentDrift(let m), .shortRead(let m),
             .sourceUnreadable(let m): return m
        }
    }
}

// MARK: - Restore / Glacier thaw

/// Glacier retrieval speed/cost tier. Deep Archive supports only `.standard` (~12h) and `.bulk` (~48h);
/// `.expedited` is Glacier-Flexible-only (S3 rejects it for Deep Archive) — kept for completeness.
public enum RestoreTier: String, Sendable, CaseIterable { case expedited, standard, bulk
    /// The retrieval wait, in seconds — the ONE place the number is written down.
    ///
    /// It exists so the app can count down ("about 9 hours left") instead of repeating a static
    /// "~48 hours" for two days, which tells someone nothing about where in it they are. Deriving that
    /// clock by PARSING `typicalWait` in the renderer was the obvious shortcut and the wrong one: the prose
    /// is UX copy and free to be reworded, and the party that picks the tier is the only one entitled to
    /// state the wait (root `RETRIEVAL.md`).
    ///
    /// An ESTIMATE of AWS's typical case, not a promise — a thaw may land early or run over, so the app has
    /// to present it as an estimate and cope with the clock running out while a transfer is still pending.
    public var typicalWaitSeconds: Int {
        switch self {
        case .expedited: return 5 * 60
        case .standard:  return 12 * 60 * 60
        case .bulk:      return 48 * 60 * 60
        }
    }

    /// Human-readable retrieval wait for CLI/UX copy (calm, factual — no drama).
    ///
    /// **Derived from `typicalWaitSeconds`, not restated beside it.** These two started life as parallel
    /// switches over the same enum whose cases had to agree by hand — "~12 hours" next to `12 * 60 * 60`,
    /// forever, with nothing to catch an edit to one and not the other. That's precisely the drift PILLAR3
    /// exists to prevent, and it would surface as a countdown that disagrees with the sentence beneath it.
    /// The number now has one home and the prose reads it.
    public var typicalWait: String {
        switch self {
        // Not derived: expedited isn't offered for Deep Archive at all, and the caveat IS the string —
        // there's no hour count that would say the useful part. Spelled out as its own case (rather than a
        // `default`) so adding a tier is still a compile error here.
        case .expedited: return "minutes (Glacier Flexible only — not Deep Archive)"
        case .standard, .bulk: return "~\(typicalWaitSeconds / 3600) hours"
        }
    }

    // A `retrievalUsdPerGB` rate card used to live here (and a `Pricing` enum beside it), quoting AWS's
    // Deep Archive list prices to the UI. Both were DELETED on 2026-07-13 and must not come back.
    //
    // They were an honest estimate of what AWS bills US — and they explicitly excluded egress, which is
    // ~36× the thaw rate. That was fine while Ben was the only user and paid AWS directly. It became a LIE
    // the moment retrieval had a real price: the app quoted restores from this card and understated the
    // actual charge by roughly 40× (root `RETRIEVAL.md`).
    //
    // What a restore costs is now decided — and stated — by the only party that can know: the account
    // backend, which prices the thaw AND the egress AND the payment fee, and applies the account's free
    // allowance (`account-backend/src/retrieval-pricing.ts`). The daemon does not quote money. If you find
    // yourself wanting a price here, you want `POST /retrieval/quote`.

    /// Parse a CLI/IPC tier argument (SSOT for both `coldstore-restore` and the daemon's `restore` command).
    /// `nil` → `.standard` (the default); an unrecognized value **throws** rather than silently downgrading —
    /// tier drives retrieval time + cost, so a typo must surface, not pass as standard.
    public static func parse(_ raw: String?) throws -> RestoreTier {
        guard let raw else { return .standard }
        guard let tier = RestoreTier(rawValue: raw.lowercased()) else {
            throw ColdStorageError.invalidRequest("bad tier '\(raw)' (expected: \(allCases.map(\.rawValue).joined(separator: " | ")))")
        }
        return tier
    }
}


/// Whether a blob object can be ranged-GET *right now*. Deep Archive / Glacier Flexible objects must be
/// thawed (RestoreObject) first; everything else (STANDARD, GLACIER_IR) serves directly.
public enum ThawState: Sendable, Equatable { case ready, needed, inProgress
    /// Pure map of a HeadObject's storage class + raw `x-amz-restore` header → state (unit-testable, no I/O).
    public static func from(storageClassRaw: String?, restoreHeader: String?) -> ThawState {
        let needsThaw = storageClassRaw == "DEEP_ARCHIVE" || storageClassRaw == "GLACIER"
        guard needsThaw else { return .ready }                       // STANDARD (nil), GLACIER_IR, …
        guard let restoreHeader else { return .needed }              // archived, never requested
        // `x-amz-restore: ongoing-request="false", expiry-date="…"` once the temporary copy is downloadable.
        return restoreHeader.contains("ongoing-request=\"false\"") ? .ready : .inProgress
    }
}

/// What a restore should DO next, given where the blob stands and whether this daemon is allowed to thaw.
///
/// Pure, exactly like `ThawState.from` above and for the same reason: `RestoreEngine.restore` is wrapped
/// in S3 I/O, so the *decision* is lifted out where it can be unit-tested — including the one case that
/// carries real money, `.needsAuthorization` (root `RETRIEVAL.md`).
public enum RestoreStep: Sendable, Equatable {
    case thaw               // frozen, and we may thaw it ourselves (dogfood)
    case needsAuthorization // frozen, and we may NOT — the backend thaws, once the restore is paid for
    case wait               // a thaw is already underway
    case download           // thawed: ranged-GET + decrypt
}

extension RestoreStep {
    /// The whole gate, in one line: a daemon that cannot thaw (`canSelfThaw == false`, i.e. running on a
    /// customer's Cognito credentials, which have no `s3:RestoreObject`) must never *attempt* a thaw on a
    /// frozen blob — it must go get the restore authorized. Everything else is unchanged by billing.
    public static func next(thaw: ThawState, canSelfThaw: Bool) -> RestoreStep {
        switch thaw {
        case .needed:     return canSelfThaw ? .thaw : .needsAuthorization
        case .inProgress: return .wait
        case .ready:      return .download
        }
    }
}

/// Result of an idempotent restore step. Re-run a restore until it returns `.restored`.
public enum RestoreOutcome: Sendable, Equatable {
    case restored                          // bytes on disk, hash-verified
    case thawRequested(tier: RestoreTier)  // a Glacier retrieval was just kicked off
    case thawInProgress                    // retrieval underway; not downloadable yet
    /// This daemon may NOT thaw (multi-user mode — see `RestoreEngine.canSelfThaw`), and the blob is
    /// still frozen. The app must get the restore AUTHORIZED by the account backend first
    /// (`POST /retrieval/quote` → pay if it's over the free allowance), which thaws it on our behalf.
    /// Carries exactly what that quote needs: which blob to thaw, and how many bytes come back.
    ///
    /// This is not an error, and must not be presented as one — it's the normal first step of a paid
    /// restore, the same way a locked door isn't a fault (root `RETRIEVAL.md`).
    case authorizationRequired(blobKey: String, egressBytes: Int)
}

/// Where one requested transfer stands — the SSOT for what every surface calls it.
///
/// The distinction that matters, and the reason this enum exists at all: for the ~48 hours a Deep Archive
/// thaw takes, **nothing is transferring**. Deep storage is waking up; no byte has moved and none will for
/// hours. Calling that "transferring" (as the UI did until this type landed) describes work that isn't
/// happening — the user watches a "download" that reports no progress for two days and reasonably concludes
/// it's broken. So the wait is `pending`, and `transferring` means exactly one thing: bytes are moving right
/// now. Named states, never a percentage — Deep Archive reports "warming" vs "ready" and nothing in between,
/// so a progress bar here would be invented (root `RETRIEVAL.md`, `ui/DESIGN.md`).
public enum RestoreState: String, Codable, Sendable, CaseIterable {
    /// Quoted but not paid: this daemon may not thaw (multi-user), so the blobs are still frozen and will
    /// stay that way until the account backend authorizes the job. The app owes a payment, not a wait.
    case needsAuthorization
    /// Authorized (paid, or free under the allowance) and thawing. THE ~48-HOUR STATE. Nothing transfers.
    case pending
    /// Thawed, and the ciphertext is actually moving over the wire right now.
    case transferring
    /// Bytes on disk at `out`, hash-verified. Terminal.
    case saved
    /// The user stopped it. Terminal, but see `resumable`: a paid thaw the user walked away from can be
    /// picked back up for free while the 5-day window lasts.
    case canceled
    /// A step failed hard. Terminal until retried; `error` carries why.
    case failed

    /// Is this transfer still working (or waiting on us) — i.e. does it belong under "Active"?
    public var isActive: Bool {
        switch self {
        case .needsAuthorization, .pending, .transferring: return true
        case .saved, .canceled, .failed: return false
        }
    }
}

/// One requested transfer, as the journal stores it. Per-DEVICE by design: a transfer targets a folder on
/// *this* Mac, so it belongs to this daemon's journal, not to the account. (The backend's `retrieval_jobs`
/// row is the billing record for the same event — `jobId` links them.)
///
/// This is journal-backed rather than held in the app because the app is the wrong place for it in three
/// separate ways, each of which was a real bug: it vanished on sign-out, it vanished on restart, and it
/// could not progress while the app was closed — though the request modal promises exactly that ("You can
/// close the app; we'll let you know when it's ready").
public struct RestoreRow: Sendable, Equatable {
    public let id: String
    /// The journal file this transfer brings back (`files.id`).
    public let fileId: String
    /// Absolute destination path on this Mac, chosen per-request in the app.
    public let out: String
    /// The account backend's retrieval job (`retrieval_jobs.id`) that authorized this thaw — the link to
    /// what was quoted and paid. `nil` in dogfood mode, where the daemon thaws on its own IAM credentials
    /// and no money changes hands.
    public let jobId: String?
    public let state: RestoreState
    public let tier: RestoreTier
    /// Plaintext bytes this transfer brings back — for display, and so the app never re-derives a size.
    public let bytes: Int
    public let requestedAt: Int
    /// When the thaw was first observed READY (i.e. when the 5-day download window started). `nil` until
    /// then. This is what makes a free resume decidable: within 5 days of this, the blob is still warm.
    public let readyAt: Int?
    /// When the run loop last actually ASKED about this transfer — stamped every pass, whatever the answer
    /// (`restorePass`). `nil` until the first pass touches it.
    ///
    /// Its job is to keep `pending` falsifiable. `pending` asserts something current — S3 says a thaw is
    /// running *right now* — but with `requestedAt` as the row's only clock, "still warming" and "nothing
    /// has looked at this since July" were the same pixels forever, and only the second is actionable.
    /// Pairs with `error`: this says when we last tried, `error` says how it went.
    public let lastStepAt: Int?
    public let completedAt: Int?
    public let error: String?

    public init(id: String, fileId: String, out: String, jobId: String?, state: RestoreState,
                tier: RestoreTier, bytes: Int, requestedAt: Int, readyAt: Int? = nil,
                lastStepAt: Int? = nil, completedAt: Int? = nil, error: String? = nil) {
        self.id = id; self.fileId = fileId; self.out = out; self.jobId = jobId; self.state = state
        self.tier = tier; self.bytes = bytes; self.requestedAt = requestedAt; self.readyAt = readyAt
        self.lastStepAt = lastStepAt; self.completedAt = completedAt; self.error = error
    }
}

extension RestoreRow {
    /// How long a thawed copy stays downloadable — the `days` we pass to `RestoreObject`. A resume inside
    /// this window costs nothing (the blob is already warm); past it, getting the file back is a genuinely
    /// new retrieval and correctly a new charge (root `RETRIEVAL.md`, "Thaw window: 5 days").
    public static let thawWindowSeconds = 5 * 24 * 60 * 60

    /// How long a transfer may go un-stepped before the app must stop calling its wait live.
    ///
    /// Derived from the run loop's OWN beat, and computed here rather than in the app, for the reason
    /// `typicalWait` moved to the backend (root `RETRIEVAL.md`): only the party that sets the cadence can
    /// honestly say what a suspicious silence looks like. The renderer briefly hardcoded a day, which was
    /// right for a 300s beat and silently wrong for any other — and `COLDSTORE_INTERVAL` is configurable.
    ///
    /// The floor dominates at normal cadence and is what the number is really for: `restorePass` is
    /// sequential, so one multi-hour download legitimately holds up every row behind it, and a threshold
    /// tight enough to catch that would cry stalled over a transfer that is working perfectly.
    public static func staleAfter(intervalSeconds: Int) -> Int {
        max(intervalSeconds * 24, 24 * 60 * 60)
    }

    /// Can a stopped transfer be picked back up **without paying again**? True only while the blob this job
    /// already paid to thaw is still warm. Pure so the rule lives in one place and is unit-testable — the
    /// app must never decide this for itself, because deciding it wrong charges someone twice.
    public func isResumable(now: Int) -> Bool {
        switch state {
        case .canceled, .failed:
            guard let readyAt else { return false }   // never thawed ⇒ nothing warm to resume onto
            return now - readyAt < Self.thawWindowSeconds
        case .needsAuthorization, .pending, .transferring, .saved:
            return false
        }
    }
}
