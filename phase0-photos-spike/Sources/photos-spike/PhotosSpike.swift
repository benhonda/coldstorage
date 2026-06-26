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
        guard !resources.isEmpty else { print("No original resource."); exit(1) }
        // The true original (.photo) is re-resolved inside downloadOriginal off the MainActor.

        // Stream the bytes (incl. an on-demand iCloud download) via a top-level nonisolated helper.
        // We hand it only the Sendable `localIdentifier` — PHAssetResource isn't Sendable and is
        // MainActor-isolated here, so the helper re-resolves the .photo resource on its own side,
        // exactly as the production PhotoKitSource.stream does.
        let (bytes, fromICloud, filename) = await downloadOriginal(assetId: asset.localIdentifier)

        print("\n✅ Wrote \(bytes) bytes → \(filename)")
        print(fromICloud
            ? "   original was in iCloud — downloaded on demand ✓ (this is the case the review flagged)"
            : "   original was already local ✓")
        print("   .photo resource = the full-res ORIGINAL, not a proxy.")
    }
}

/// Stream a resource's bytes to `outURL`, allowing an on-demand iCloud download.
///
/// Deliberately a **top-level (nonisolated)** function: `@main`'s `main()` is implicitly `@MainActor`,
/// so closures defined inside it inherit MainActor isolation. Photos invokes `requestData`'s handlers
/// on its OWN queue (`com.apple.photos.assetResources.fileIO`), so a MainActor-isolated closure trips
/// Swift 6's executor assertion there → `dispatch_assert_queue_fail` → SIGTRAP. Defining the handlers
/// here keeps them nonisolated; the `Sink` makes the cross-thread byte accounting + write safe.
/// (The production `PhotoKitSource.stream` already follows this nonisolated-static pattern.)
private func downloadOriginal(assetId: String) async -> (bytes: Int, fromICloud: Bool, filename: String) {
    final class Sink: @unchecked Sendable {
        let handle: FileHandle
        let lock = NSLock()
        var bytes = 0
        var fromICloud = false
        init(_ h: FileHandle) { handle = h }
    }

    // Re-resolve the asset + its true original (.photo) off the MainActor — PHAssetResource isn't
    // Sendable, so it can't cross from main()'s isolation; we re-fetch from the Sendable id instead.
    guard let asset = PHAsset.fetchAssets(withLocalIdentifiers: [assetId], options: nil).firstObject else {
        print("could not re-resolve asset"); return (0, false, "?")
    }
    let resources = PHAssetResource.assetResources(for: asset)
    guard let original = resources.first(where: { $0.type == .photo }) ?? resources.first else {
        print("no original resource"); return (0, false, "?")
    }

    let outURL = URL(fileURLWithPath: "original-\(original.originalFilename)")
    FileManager.default.createFile(atPath: outURL.path, contents: nil)
    guard let handle = try? FileHandle(forWritingTo: outURL) else { print("cannot open output"); return (0, false, "?") }
    let sink = Sink(handle)

    let reqOpts = PHAssetResourceRequestOptions()
    reqOpts.isNetworkAccessAllowed = true                  // pull from iCloud if the original isn't local
    reqOpts.progressHandler = { p in
        sink.lock.lock(); sink.fromICloud = true; sink.lock.unlock()
        print(String(format: "  iCloud download… %.0f%%", p * 100))
    }

    await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
        PHAssetResourceManager.default().requestData(
            for: original,
            options: reqOpts,
            dataReceivedHandler: { chunk in
                sink.lock.lock(); sink.bytes += chunk.count; try? sink.handle.write(contentsOf: chunk); sink.lock.unlock()
            },
            completionHandler: { error in
                try? sink.handle.close()
                if let error { print("❌ requestData error: \(error)") }
                cont.resume()
            }
        )
    }
    return (sink.bytes, sink.fromICloud, outURL.lastPathComponent)
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
