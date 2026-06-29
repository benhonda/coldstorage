#if canImport(Photos)
import Foundation
import Photos
import ColdStorageCore

/// Streams full-res originals from the Photos library (incl. iCloud download) — the proven mechanics
/// from phase0-photos-spike.
///
/// IMPORTANT (product decision 2026-06-26): photo ingest is **explicit-deposit only**. `enumerate()`
/// returns the WHOLE library, so this MUST NOT be wired into the daemon's background run loop —
/// auto-archiving everything is invasive and rejected. The explicit photo-deposit path (user picks
/// photos → archive only those, mirroring `ExplicitPathsSource`) is the intended consumer and should
/// reuse `stream(assetId:)` for the bytes; until it's built, the daemon never instantiates this.
public struct PhotoKitSource: IngestSource {
    public init() {}

    public func enumerate() async throws -> [IngestItem] {
        // The daemon requests Photos authorization at startup (TCC); assume granted here.
        let opts = PHFetchOptions()
        opts.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        let assets = PHAsset.fetchAssets(with: .image, options: opts)

        var items: [IngestItem] = []
        assets.enumerateObjects { asset, _, _ in
            guard let res = PHAssetResource.assetResources(for: asset).first(where: { $0.type == .photo }) else { return }
            // Capture only the Sendable id in `open`; PHAssetResource isn't Sendable, so it can't cross
            // the @Sendable boundary — `stream` re-resolves it on the consuming thread (see below).
            let assetId = asset.localIdentifier
            items.append(IngestItem(
                id: assetId,
                relativePath: res.originalFilename,
                size: 0,                                    // unknown until streamed
                contentHash: assetId,                       // TODO: real plaintext SHA-256 via a hashing pre-pass
                createdAt: asset.creationDate,
                isFavorite: asset.isFavorite,
                metadata: ["uti": res.uniformTypeIdentifier],
                open: { Self.stream(assetId: assetId) }))
        }
        return items
    }

    /// Re-resolve the asset's photo resource by stable id, then stream it (incl. iCloud download). We
    /// resolve here rather than capturing the PHAssetResource: it isn't Sendable, so it can't be carried
    /// across the @Sendable `open` boundary onto whatever thread the upload engine pulls bytes on.
    static func stream(assetId: String) -> AsyncThrowingStream<Data, Error> {
        AsyncThrowingStream { cont in
            let fetched = PHAsset.fetchAssets(withLocalIdentifiers: [assetId], options: nil)
            guard let asset = fetched.firstObject,
                  let res = PHAssetResource.assetResources(for: asset).first(where: { $0.type == .photo })
            else { cont.finish(throwing: CocoaError(.fileNoSuchFile)); return }
            let o = PHAssetResourceRequestOptions(); o.isNetworkAccessAllowed = true   // pull from iCloud if needed
            PHAssetResourceManager.default().requestData(for: res, options: o,
                dataReceivedHandler: { cont.yield($0) },
                completionHandler: { err in err.map { cont.finish(throwing: $0) } ?? cont.finish() })
        }
    }
}

/// The Mac implementation of the core `PhotoResolver` seam — the consumer of the explicit photo-deposit
/// path. Resolves explicitly-picked asset IDs into archivable items, reusing the proven
/// `PhotoKitSource.stream(assetId:)` for the bytes (full-res original incl. iCloud download). Unlike
/// `PhotoKitSource.enumerate()` (the whole library — DO NOT background-wire), this touches ONLY the picked
/// assets, mirroring `ExplicitPathsSource`. A missing/denied/stale id is skipped (a stale pick from the UI
/// must not abort the deposit). Size is left 0 here — unknown until streamed, and the integrity SHA-256 is
/// computed from the real bytes at archive time (`UploadEngine.archive`), so `contentHash` is metadata only.
public struct PhotoKitResolver: PhotoResolver {
    public init() {}

    public func resolve(assetIds: [String]) async throws -> [IngestItem] {
        // Ensure the DAEMON's own Photos authorization first. `fetchAssets` neither prompts nor errors when
        // unauthorized — it just returns empty — so without this a missing grant silently archives nothing.
        // `requestAuthorization` prompts on first call (a launchd daemon CAN prompt + the grant persists —
        // phase0-photos-spike) and is a no-op once decided. TCC keys the grant to the RESPONSIBLE process, so
        // a grant the picker/terminal got does NOT transfer here — the daemon must request its own.
        var status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        if status == .notDetermined {
            status = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
        }
        // FULL access is REQUIRED for this flow: the user picks via PHPicker in a SEPARATE process, so the
        // daemon must resolve arbitrary localIdentifiers. Under `.limited` it can only see its own selected
        // set (not the picker's) → resolves nothing. THROW (not return []) so the deposit surfaces a clear,
        // recoverable error to the UI instead of silently flashing the picked rows then dropping them. The
        // message is the user-facing sentence the toast shows; the `photosAccess` case drives the UI's
        // "Open Photos settings" action (the deep-link), so we don't spell out the menu path here.
        guard status == .authorized else {
            let why = status == .limited
                ? "ColdStorage has limited access to your photos. To upload the ones you pick, give it access to all photos."
                : "ColdStorage doesn’t have permission to read your photos."
            FileHandle.standardError.write(Data("PhotoKitResolver: \(why) (status \(status.rawValue)) Archiving no photos.\n".utf8))
            throw ColdStorageError.photosAccess(why)
        }

        let fetched = PHAsset.fetchAssets(withLocalIdentifiers: assetIds, options: nil)
        var items: [IngestItem] = []
        fetched.enumerateObjects { asset, _, _ in
            guard let res = PHAssetResource.assetResources(for: asset).first(where: { $0.type == .photo }) else { return }
            // Capture only the Sendable id (PHAssetResource isn't Sendable) — `stream` re-resolves it on the
            // consuming thread, exactly as the background source does.
            let assetId = asset.localIdentifier
            items.append(IngestItem(
                id: assetId,
                relativePath: res.originalFilename,
                size: 0,                                    // unknown until streamed; real hash computed at archive time
                contentHash: assetId,                       // metadata key only (see UploadEngine.archive)
                createdAt: asset.creationDate,
                isFavorite: asset.isFavorite,
                metadata: ["uti": res.uniformTypeIdentifier],
                open: { PhotoKitSource.stream(assetId: assetId) }))
        }
        // Observability: a count mismatch points at stale picks or (more likely) an id the daemon can't see.
        // The "nothing resolved at all → surface it" policy lives in `PhotoDepositSource.enumerate` (Core), so
        // it's platform-independent + testable; here we just report the count and hand back what we resolved.
        FileHandle.standardError.write(Data("PhotoKitResolver: requested \(assetIds.count), resolved \(items.count).\n".utf8))
        return items
    }
}
#endif
