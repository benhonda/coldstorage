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
#endif
