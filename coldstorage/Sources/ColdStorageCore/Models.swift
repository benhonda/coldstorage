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
    public init(id: String, kind: SourceKind, path: String?) { self.id = id; self.kind = kind; self.path = path }
}

public enum FileStatus: String, Codable, Sendable { case discovered, planned, staging, uploading, verifying, archived, failed }
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
