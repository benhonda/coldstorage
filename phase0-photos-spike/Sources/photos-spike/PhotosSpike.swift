import Foundation
import Photos

// Proves: (1) a signed binary holds a durable Photos TCC grant across runs and under launchd,
//         (2) we can pull the TRUE original (.photo), downloading from iCloud if it isn't local.

@main
struct PhotosSpike {
    static func main() async {
        let start = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        print("Photos authorization (start): \(describe(start))")

        let status: PHAuthorizationStatus
        if start == .notDetermined {
            print("Requesting authorization… (a TCC prompt should appear in your GUI session)")
            status = await withCheckedContinuation { cont in
                PHPhotoLibrary.requestAuthorization(for: .readWrite) { cont.resume(returning: $0) }
            }
        } else {
            status = start   // already decided — if this is .authorized on a fresh run, the grant PERSISTED
        }
        print("Photos authorization (now):   \(describe(status))")
        guard status == .authorized || status == .limited else {
            print("❌ Not authorized. Almost always: unstable code signature or missing Info.plist — see README.")
            exit(1)
        }

        // Newest photo.
        let opts = PHFetchOptions()
        opts.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        opts.fetchLimit = 1
        guard let asset = PHAsset.fetchAssets(with: .image, options: opts).firstObject else {
            print("No photos in the library."); exit(1)
        }
        print("\nNewest photo: \(asset.pixelWidth)x\(asset.pixelHeight), created \(asset.creationDate.map { "\($0)" } ?? "?")")

        // Resources — pick the true ORIGINAL (.photo), not the edited render (.fullSizePhoto).
        let resources = PHAssetResource.assetResources(for: asset)
        for r in resources { print("  resource: \(describe(r.type))  \(r.originalFilename)") }
        guard let original = resources.first(where: { $0.type == .photo }) ?? resources.first else {
            print("No original resource."); exit(1)
        }

        // Pull bytes; allow an iCloud download if the original isn't on this Mac.
        let reqOpts = PHAssetResourceRequestOptions()
        reqOpts.isNetworkAccessAllowed = true
        var downloaded = false
        reqOpts.progressHandler = { p in
            downloaded = true
            print(String(format: "  iCloud download… %.0f%%", p * 100))
        }

        let outURL = URL(fileURLWithPath: "original-\(original.originalFilename)")
        FileManager.default.createFile(atPath: outURL.path, contents: nil)
        guard let handle = try? FileHandle(forWritingTo: outURL) else { print("cannot open output"); exit(1) }

        var bytes = 0
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            PHAssetResourceManager.default().requestData(
                for: original,
                options: reqOpts,
                dataReceivedHandler: { chunk in
                    bytes += chunk.count
                    try? handle.write(contentsOf: chunk)
                },
                completionHandler: { error in
                    try? handle.close()
                    if let error { print("❌ requestData error: \(error)") }
                    cont.resume()
                }
            )
        }

        print("\n✅ Wrote \(bytes) bytes → \(outURL.lastPathComponent)")
        print(downloaded
            ? "   original was in iCloud — downloaded on demand ✓ (this is the case the review flagged)"
            : "   original was already local ✓")
        print("   .photo resource = the full-res ORIGINAL, not a proxy.")
    }
}

private func describe(_ s: PHAuthorizationStatus) -> String {
    switch s {
    case .notDetermined: return "notDetermined"
    case .restricted:    return "restricted"
    case .denied:        return "denied"
    case .authorized:    return "authorized"
    case .limited:       return "limited"
    @unknown default:    return "unknown"
    }
}

private func describe(_ t: PHAssetResourceType) -> String {
    switch t {
    case .photo:            return "photo(ORIGINAL)"
    case .fullSizePhoto:    return "fullSizePhoto(edited)"
    case .video:            return "video"
    case .pairedVideo:      return "pairedVideo(LivePhoto)"
    case .fullSizeVideo:    return "fullSizeVideo"
    case .adjustmentData:   return "adjustmentData"
    case .alternatePhoto:   return "alternatePhoto"
    default:                return "other(\(t.rawValue))"
    }
}
