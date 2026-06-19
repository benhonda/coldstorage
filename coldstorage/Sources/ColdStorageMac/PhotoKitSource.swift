#if canImport(Photos)
import Foundation
import Photos
import ColdStorageCore

/// Production macOS source: streams full-res originals from the Photos library (incl. iCloud download).
/// Implements the same `IngestSource` boundary the portable core depends on.
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
            items.append(IngestItem(
                id: asset.localIdentifier,
                relativePath: res.originalFilename,
                size: 0,                                    // unknown until streamed
                contentHash: asset.localIdentifier,         // TODO: real plaintext SHA-256 via a hashing pre-pass
                createdAt: asset.creationDate,
                isFavorite: asset.isFavorite,
                metadata: ["uti": res.uniformTypeIdentifier],
                open: { Self.stream(res) }))
        }
        return items
    }

    static func stream(_ res: PHAssetResource) -> AsyncThrowingStream<Data, Error> {
        AsyncThrowingStream { cont in
            let o = PHAssetResourceRequestOptions(); o.isNetworkAccessAllowed = true   // pull from iCloud if needed
            PHAssetResourceManager.default().requestData(for: res, options: o,
                dataReceivedHandler: { cont.yield($0) },
                completionHandler: { err in err.map { cont.finish(throwing: $0) } ?? cont.finish() })
        }
    }
}
#endif
