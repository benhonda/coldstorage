import Foundation

/// The boundary that lets the portable core deposit Photos-library assets without importing PhotoKit —
/// the photo analogue of how `IngestSource` keeps platform specifics out of Core. The Mac adapter
/// implements this (resolving asset IDs → full-res original streams + metadata via PhotoKit); Linux/CI
/// has none, so `depositPhotos` reports photos-unavailable rather than failing obscurely.
public protocol PhotoResolver: Sendable {
    /// Resolve explicitly-picked Photos asset IDs into archivable items — one per resolvable asset. An
    /// individual stale/unreadable id is DROPPED (a single stale pick must not abort the whole deposit),
    /// but a *systemic* failure THROWS so the deposit surfaces a clear, recoverable error instead of
    /// silently archiving nothing: `photosAccess` when the daemon lacks (full) Photos access, and
    /// `photosNoneResolved` when access is granted yet none of the picks resolve. Each item's `open`
    /// streams the full-res original, downloading from iCloud if needed (the proven
    /// `PhotoKitSource.stream(assetId:)` mechanics). `id` is the asset's stable `localIdentifier`;
    /// `relativePath` is its original filename.
    func resolve(assetIds: [String]) async throws -> [IngestItem]
}

/// Ad-hoc ingest of explicitly-picked Photos-library assets — the photo analogue of `ExplicitPathsSource`
/// (the UI's photo-picker **deposit**, NOT a watched source). Resolves picked asset IDs to full-res
/// originals via a `PhotoResolver`, placing each under `destDir` (the browser folder picked into; "" =
/// root). Photos are explicit-deposit only (product decision 2026-06-26) — never auto-watched, so this is
/// only ever a one-shot deposit, never the daemon's run-loop source.
public struct PhotoDepositSource: IngestSource {
    let resolver: any PhotoResolver
    let assetIds: [String]
    /// Destination folder (vault-relative; "" = root) the user picked the photos into.
    let destDir: String

    public init(resolver: any PhotoResolver, assetIds: [String], destDir: String) {
        self.resolver = resolver; self.assetIds = assetIds; self.destDir = destDir
    }

    public func enumerate() async throws -> [IngestItem] {
        // Re-base each resolved asset under dest for display/placement, but keep `id` = the asset's stable
        // localIdentifier — so re-depositing the SAME photo dedups on its identity (the journal's upsert
        // key), not on a filename that can collide across distinct photos (IMG_0001.jpg). Moves/deletes
        // still operate by `relativePath`, independent of `id`, so path-keyed reorg keeps working.
        let items = try await resolver.resolve(assetIds: assetIds).map { it in
            IngestItem(id: it.id, relativePath: ExplicitPathsSource.join(destDir, it.relativePath),
                       size: it.size, contentHash: it.contentHash, createdAt: it.createdAt,
                       isFavorite: it.isFavorite, metadata: it.metadata, open: it.open)
        }
        // Nothing resolved → nothing would be archived. Surface it (don't silently no-op) so the picked rows
        // can't just flash then vanish. A PARTIAL resolve (some stale ids dropped) still proceeds for the ones
        // that did resolve — one stale pick must not sink the rest. Empty `assetIds` can't reach here (the
        // daemon rejects it up front), so an empty result here always means real picks that all failed to load.
        guard !items.isEmpty else {
            throw ColdStorageError.photosNoneResolved("Couldn’t find the photos you picked — they may have been removed or changed.")
        }
        return items
    }
}
