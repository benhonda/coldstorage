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
    public let createdAt: Date?
    public let isFavorite: Bool
    public let metadata: [String: String]  // EXIF, album, Live-Photo pairing, …
    public let open: @Sendable () -> AsyncThrowingStream<Data, Error>  // plaintext byte stream

    public init(id: String, relativePath: String, size: Int, content: ContentKey,
                createdAt: Date?, isFavorite: Bool, metadata: [String: String] = [:],
                open: @escaping @Sendable () -> AsyncThrowingStream<Data, Error>) {
        self.id = id; self.relativePath = relativePath; self.size = size
        self.content = content; self.createdAt = createdAt
        self.isFavorite = isFavorite; self.metadata = metadata; self.open = open
    }

    /// A copy re-keyed to a new vault path (path-keyed sources use id == relativePath), preserving the
    /// captured byte stream + intrinsic metadata. Used to "Keep Both" a colliding deposit under a fresh name.
    func rekeyed(to relativePath: String) -> IngestItem {
        IngestItem(id: relativePath, relativePath: relativePath, size: size, content: content,
                   createdAt: createdAt, isFavorite: isFavorite, metadata: metadata, open: open)
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
    public init(id: String, kind: SourceKind, path: String?, mountPath: String = "", paused: Bool = false) {
        self.id = id; self.kind = kind; self.path = path; self.mountPath = mountPath; self.paused = paused
    }
}

/// `deleted` is a TOMBSTONE: the user removed the file from their tree, but its row + blob mapping are
/// kept (bytes reclaim is deferred to a future repack/GC — deep storage has a 180-day minimum, so eager
/// deletion saves nothing). Tombstoned files drop out of `listFiles` and the file count.
///
/// `folder` is a FOLDER MARKER: a path-only row (size 0, no blob) that anchors a just-created EMPTY folder
/// so it survives a reload — otherwise an empty folder, having no files beneath it to imply its path, would
/// vanish (the tree is derived from file paths). The marker is excluded from the file count and never
/// becomes a browsable file; `movePath`/`deletePath` sweep it by path like any other row. Once real files
/// land under the folder the marker is redundant (the path is implied) but harmless — the UI dedups by name.
/// `uploading`/`verifying` are declared but never persisted — the journal only ever writes `planned`,
/// `archived`, `failed`, `deleted` and `folder` (plus `discovered` as the decoder's fallback). They're the
/// hooks for a future per-file progress state. A `staging` case sat here too until the upload engine stopped
/// staging (2026-07-14) — it named a step that no longer exists, so it's gone.
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

public enum FileStatus: String, Codable, Sendable { case discovered, planned, uploading, verifying, archived, failed, deleted, folder }
public enum BlobStatus: String, Codable, Sendable { case open, uploading, completed, verified, aborted }
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
    /// The bare message — so `"\(error)"` (CLI stderr, daemon wire `error` field) reads cleanly instead
    /// of leaking the case name (`invalidRequest("…")`).
    public var description: String {
        switch self {
        case .s3(let m), .integrity(let m), .invalidRequest(let m), .photosAccess(let m),
             .photosNoneResolved(let m), .contentDrift(let m): return m
        }
    }
}

// MARK: - Restore / Glacier thaw

/// Glacier retrieval speed/cost tier. Deep Archive supports only `.standard` (~12h) and `.bulk` (~48h);
/// `.expedited` is Glacier-Flexible-only (S3 rejects it for Deep Archive) — kept for completeness.
public enum RestoreTier: String, Sendable, CaseIterable { case expedited, standard, bulk
    /// Human-readable retrieval wait for CLI/UX copy (calm, factual — no drama).
    public var typicalWait: String {
        switch self {
        case .expedited: return "minutes (Glacier Flexible only — not Deep Archive)"
        case .standard:  return "~12 hours"
        case .bulk:      return "~48 hours"
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
