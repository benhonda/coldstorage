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
        // Re-base each resolved asset under dest and key it by that vault `relativePath` (id == path),
        // EXACTLY like `ExplicitPathsSource` — so photos behave like files: the same photo dropped into a
        // NEW folder is a new copy, and re-depositing into the SAME folder is idempotent (same path → same
        // id). Dedup is NO LONGER keyed on Photos identity (which silently moved a photo across folders);
        // same-name collisions in a folder are surfaced to the user via the deposit collision prompt
        // (`CollisionResolvingSource`), never silently merged. Streaming is unaffected — `open` was built by
        // the resolver from the assetId and is carried verbatim here, independent of `id`.
        let items = try await resolver.resolve(assetIds: assetIds).map { it in
            let rel = ExplicitPathsSource.join(destDir, it.relativePath)
            return IngestItem(id: rel, relativePath: rel,
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
