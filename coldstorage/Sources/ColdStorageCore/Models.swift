import Foundation

/// A single user file/photo to archive, plus the metadata that drives ordering + change detection.
public struct IngestItem: Sendable {
    public let id: String                  // stable key (Photos localIdentifier, or relative path)
    public let relativePath: String
    public let size: Int
    public let contentHash: String         // SHA-256 of plaintext — change/dedupe key
    public let createdAt: Date?
    public let isFavorite: Bool
    public let metadata: [String: String]  // EXIF, album, Live-Photo pairing, …
    public let open: @Sendable () -> AsyncThrowingStream<Data, Error>  // plaintext byte stream

    public init(id: String, relativePath: String, size: Int, contentHash: String,
                createdAt: Date?, isFavorite: Bool, metadata: [String: String] = [:],
                open: @escaping @Sendable () -> AsyncThrowingStream<Data, Error>) {
        self.id = id; self.relativePath = relativePath; self.size = size
        self.contentHash = contentHash; self.createdAt = createdAt
        self.isFavorite = isFavorite; self.metadata = metadata; self.open = open
    }
}

/// A group of items that becomes one S3 object. Small files batched; large files solo.
public struct BlobPlan: Sendable {
    public let id: String
    public let items: [IngestItem]
    public init(id: String, items: [IngestItem]) { self.id = id; self.items = items }
    public var s3Key: String { "blobs/\(id)" }
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
public enum FileStatus: String, Codable, Sendable { case discovered, planned, staging, uploading, verifying, archived, failed, deleted, folder }
public enum BlobStatus: String, Codable, Sendable { case open, uploading, completed, verified, aborted }
public enum PartStatus: String, Codable, Sendable { case pending, uploaded, verified }

public enum ColdStorageError: Error, CustomStringConvertible {
    case s3(String), integrity(String), staging(String)
    /// The bare message — so `"\(error)"` (CLI stderr, daemon wire `error` field) reads cleanly instead
    /// of leaking the case name (`staging("…")`).
    public var description: String {
        switch self { case .s3(let m), .integrity(let m), .staging(let m): return m }
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

    /// Glacier *retrieval* fee, USD per GB, for this tier — the public S3 Glacier Deep Archive list price
    /// (us-east-1). The SSOT the daemon quotes a get-a-copy-back fee from, co-located with `typicalWait`
    /// so a tier carries its whole speed/cost story in one place. An ESTIMATE by nature (AWS changes list
    /// prices, other regions differ); we quote this dominant per-GB term only — per-request fees + egress
    /// are excluded to keep the number calm and legible. See `Pricing` for the storage rate + disclaimer.
    public var retrievalUsdPerGB: Double {
        switch self {
        case .expedited: return 0.03    // Glacier Flexible only — never valid for Deep Archive
        case .standard:  return 0.02
        case .bulk:      return 0.0025
        }
    }

    /// Parse a CLI/IPC tier argument (SSOT for both `coldstore-restore` and the daemon's `restore` command).
    /// `nil` → `.standard` (the default); an unrecognized value **throws** rather than silently downgrading —
    /// tier drives retrieval time + cost, so a typo must surface, not pass as standard.
    public static func parse(_ raw: String?) throws -> RestoreTier {
        guard let raw else { return .standard }
        guard let tier = RestoreTier(rawValue: raw.lowercased()) else {
            throw ColdStorageError.staging("bad tier '\(raw)' (expected: \(allCases.map(\.rawValue).joined(separator: " | ")))")
        }
        return tier
    }
}

/// The storage/retrieval **rate card** the daemon quotes to the UI (the `getPricing` command) — the
/// pricing SSOT, so cost copy lives in ONE place instead of magic numbers scattered across views. Public
/// S3 Glacier Deep Archive list prices (us-east-1). ESTIMATES, stated as such: AWS revises list prices,
/// other regions cost more, and we surface only the dominant per-GB terms (no per-request fee, no egress)
/// to keep the figure calm and honest. The per-tier *retrieval* rate lives on `RestoreTier`; this holds
/// the storage rate, the valid Deep-Archive tiers, and the disclaimer shown beside any quote.
public enum Pricing {
    /// Deep Archive storage, USD per GB per month (us-east-1 list price).
    public static let storageUsdPerGBMonth = 0.00099
    /// The tiers a Deep Archive object can actually be retrieved with (`.expedited` is Flexible-only).
    public static let deepArchiveTiers: [RestoreTier] = [.standard, .bulk]
    /// Always shown with a quote so we never assert a price as fact.
    public static let estimateNote = "Estimate — public AWS list prices, before tax and small per-request fees."
}

/// Whether a blob object can be ranged-GET *right now*. Deep Archive / Glacier Flexible objects must be
/// thawed (RestoreObject) first; everything else (STANDARD/MinIO, GLACIER_IR) serves directly.
public enum ThawState: Sendable, Equatable { case ready, needed, inProgress
    /// Pure map of a HeadObject's storage class + raw `x-amz-restore` header → state (unit-testable, no I/O).
    public static func from(storageClassRaw: String?, restoreHeader: String?) -> ThawState {
        let needsThaw = storageClassRaw == "DEEP_ARCHIVE" || storageClassRaw == "GLACIER"
        guard needsThaw else { return .ready }                       // STANDARD (nil on MinIO), GLACIER_IR, …
        guard let restoreHeader else { return .needed }              // archived, never requested
        // `x-amz-restore: ongoing-request="false", expiry-date="…"` once the temporary copy is downloadable.
        return restoreHeader.contains("ongoing-request=\"false\"") ? .ready : .inProgress
    }
}

/// Result of an idempotent restore step. Re-run a restore until it returns `.restored`.
public enum RestoreOutcome: Sendable, Equatable {
    case restored                          // bytes on disk, hash-verified
    case thawRequested(tier: RestoreTier)  // a Glacier retrieval was just kicked off
    case thawInProgress                    // retrieval underway; not downloadable yet
}
