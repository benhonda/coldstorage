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
    /// Where a pushed asset materializes while it streams — the signed-in user's scratch dir. See
    /// `stream(assetId:scratch:)`.
    let scratchDir: URL
    public init(scratchDir: URL) { self.scratchDir = scratchDir }

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
            let scratch = Self.scratchURL(in: scratchDir, for: assetId)
            items.append(IngestItem(
                id: assetId,
                relativePath: res.originalFilename,
                size: 0,                                    // unknown until streamed
                content: .opaque(assetId),                  // an identity, NOT a hash — nothing to verify against
                createdAt: asset.creationDate,
                isFavorite: asset.isFavorite,
                metadata: ["uti": res.uniformTypeIdentifier],
                open: { Self.stream(assetId: assetId, scratch: scratch) }))
        }
        return items
    }

    /// Re-resolve the asset's photo resource by stable id, then stream it (incl. iCloud download). We
    /// resolve here rather than capturing the PHAssetResource: it isn't Sendable, so it can't be carried
    /// across the @Sendable `open` boundary onto whatever thread the upload engine pulls bytes on.
    ///
    /// PhotoKit is a **push** producer: `requestData` hands us chunks as fast as it can read/download them,
    /// and there is no way to tell it to wait. This used to yield those chunks straight into an
    /// `AsyncThrowingStream`, whose buffer is unbounded — so a 10 GB video became 10 GB of resident memory
    /// in the daemon (the 2026-07-14 crash; see `ByteStreams.swift`).
    ///
    /// `writeData` is the same download, drained to a file instead of to us. PhotoKit does its own bounded
    /// buffering, finishes at full speed, and lets go of the iCloud session; we then pull the file back at
    /// the upload's pace. `scratchFileStream` runs it lazily on first demand and deletes the file on every
    /// exit path (EOF, throw, cancelled deposit).
    /// A scratch path for one asset. Derived from the asset id (not random) so a re-run reuses the same
    /// name instead of littering a fresh file per attempt; the leading `photo-` keeps it clear of the
    /// engine's blob ids, which share this dir. `/` and `:` appear in Photos localIdentifiers.
    static func scratchURL(in dir: URL, for assetId: String) -> URL {
        let safe = assetId.replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: ":", with: "_")
        return dir.appendingPathComponent("photo-\(safe)")
    }

    static func stream(assetId: String, scratch: URL) -> AsyncThrowingStream<Data, Error> {
        scratchFileStream(at: scratch) { url in
            try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
                let fetched = PHAsset.fetchAssets(withLocalIdentifiers: [assetId], options: nil)
                guard let asset = fetched.firstObject,
                      let res = PHAssetResource.assetResources(for: asset).first(where: { $0.type == .photo })
                else { cont.resume(throwing: CocoaError(.fileNoSuchFile)); return }
                let o = PHAssetResourceRequestOptions(); o.isNetworkAccessAllowed = true   // pull from iCloud if needed
                PHAssetResourceManager.default().writeData(for: res, toFile: url, options: o) { err in
                    err.map { cont.resume(throwing: $0) } ?? cont.resume(returning: ())
                }
            }
        }
    }
}

/// The Mac implementation of the core `PhotoResolver` seam — the consumer of the explicit photo-deposit
/// path. Resolves explicitly-picked asset IDs into archivable items, reusing the proven
/// `PhotoKitSource.stream(assetId:)` for the bytes (full-res original incl. iCloud download). Unlike
/// `PhotoKitSource.enumerate()` (the whole library — DO NOT background-wire), this touches ONLY the picked
/// assets, mirroring `ExplicitPathsSource`. A missing/denied/stale id is skipped (a stale pick from the UI
/// must not abort the deposit). Size is left 0 here — unknown until streamed — and the content key is
/// `.opaque`: a Photos asset's bytes don't exist until PhotoKit produces them, so there is nothing to hash
/// ahead of the read and nothing for the engine's drift guard to check against.
public struct PhotoKitResolver: PhotoResolver {
    public init() {}

    public func resolve(assetIds: [String], scratchDir: URL) async throws -> [IngestItem] {
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
            let scratch = PhotoKitSource.scratchURL(in: scratchDir, for: assetId)
            items.append(IngestItem(
                id: assetId,
                relativePath: res.originalFilename,
                size: 0,                                    // unknown until streamed; real hash computed at archive time
                content: .opaque(assetId),                  // an identity, NOT a hash — nothing to verify against
                createdAt: asset.creationDate,
                isFavorite: asset.isFavorite,
                metadata: ["uti": res.uniformTypeIdentifier],
                open: { PhotoKitSource.stream(assetId: assetId, scratch: scratch) }))
        }
        // Observability: a count mismatch points at stale picks or (more likely) an id the daemon can't see.
        // The "nothing resolved at all → surface it" policy lives in `PhotoDepositSource.enumerate` (Core), so
        // it's platform-independent + testable; here we just report the count and hand back what we resolved.
        FileHandle.standardError.write(Data("PhotoKitResolver: requested \(assetIds.count), resolved \(items.count).\n".utf8))
        return items
    }
}
#endif
