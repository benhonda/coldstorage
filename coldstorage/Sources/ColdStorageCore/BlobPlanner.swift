import Foundation
import Crypto

/// Batches small files into locality-grouped blobs (cap ~1 GB), large files solo, ordered
/// newest/most-precious-first so "your last 30 days are safe ✓" lands quickly. Pure + deterministic:
/// the SAME files always produce the SAME blob ids, which is what lets a killed upload RESUME on
/// re-run (the journal lookup hits) instead of restarting.
public struct BlobPlanner: Sendable {
    public let blobCap: Int
    public let smallFileMax: Int
    public init(blobCap: Int = 1 << 30, smallFileMax: Int = 64 << 20) {
        self.blobCap = blobCap; self.smallFileMax = smallFileMax
    }

    /// Content-derived, stable blob id — keyed on member identity + content hashes.
    public static func stableId(_ items: [IngestItem]) -> String {
        let key = items.map { "\($0.id):\($0.content.planKey)" }.sorted().joined(separator: "\n")
        return SHA256.hash(data: Data(key.utf8)).prefix(16).hex
    }

    /// Newest/most-precious first — the order that makes "your last 30 days are safe ✓" land quickly.
    /// It is a property of the ORDER blobs go up in, not of what's inside them: hence it is applied to the
    /// blobs at the end, and only used to sort items *within* a folder — never to decide who batches with whom.
    static func newestFirst(_ a: IngestItem, _ b: IngestItem) -> Bool {
        if a.isFavorite != b.isFavorite { return a.isFavorite }                       // favorites first
        let (ca, cb) = (a.createdAt ?? .distantPast, b.createdAt ?? .distantPast)
        if ca != cb { return ca > cb }                                                // newest first
        return a.id < b.id                                                            // stable tiebreaker → deterministic
    }

    private static func folder(of item: IngestItem) -> String {
        (item.relativePath as NSString).deletingLastPathComponent
    }

    /// **Group by FOLDER first, then order by recency.**
    ///
    /// This used to sort by date and then break the batch whenever the folder changed — which sounds like
    /// locality grouping and isn't. Dates interleave folders (an ordinary drop has recent files in several
    /// places at once), so the "same folder?" check fired on nearly every item and flushed the bucket before
    /// it ever filled. A 100-file deposit across four folders produced **100 blobs**, not four.
    ///
    /// That is not a tidiness problem — it is the upload's speed. Every blob costs four SEQUENTIAL S3 round trips
    /// (`CreateMultipartUpload` → `UploadPart` → `CompleteMultipartUpload` → a `HEAD` to verify), so a
    /// fragmented plan turns a deposit into a latency queue: 1000 files became thousands of round trips and
    /// took minutes no matter how fast the link was (observed 2026-07-14).
    ///
    /// **Blob ids are derived from their members, so changing the grouping changes the ids.** Files already
    /// archived under the old, fragmented ids will be re-uploaded once under their new batched ones, and the
    /// old objects are orphaned in S3 (harmless — they're unreferenced, and the abort/lifecycle rules apply).
    /// A one-time cost, paid before any customer exists.
    ///
    /// `prefix` namespaces every produced blob's S3 key (a signed-in user's `blobs/<identity-id>`). It does
    /// NOT affect the content-derived blob `id` — only where the object lands — so the same files
    /// resume/dedup identically regardless of which user owns them.
    public func plan(_ items: [IngestItem], prefix: VaultPrefix) -> [BlobPlan] {
        var blobs: [BlobPlan] = []

        // Large files go solo: batching them buys nothing (the per-object overhead is already amortised over
        // their own size) and a solo blob is what gives them a determinate progress bar.
        for item in items where item.size > smallFileMax {
            blobs.append(BlobPlan(id: Self.stableId([item]), items: [item], prefix: prefix))
        }

        // Small files: bucket by folder, so a folder-restore pulls few objects — the actual point of batching.
        var byFolder: [String: [IngestItem]] = [:]
        for item in items where item.size <= smallFileMax {
            byFolder[Self.folder(of: item), default: []].append(item)
        }
        // Sorted keys: dictionary order is not deterministic, and blob ids must be reproducible across runs or
        // resume can't find its own blob.
        for folder in byFolder.keys.sorted() {
            var bucket: [IngestItem] = []
            var bucketSize = 0
            for item in byFolder[folder]!.sorted(by: Self.newestFirst) {
                if !bucket.isEmpty, bucketSize + item.size > blobCap {
                    blobs.append(BlobPlan(id: Self.stableId(bucket), items: bucket, prefix: prefix))
                    bucket = []; bucketSize = 0
                }
                bucket.append(item); bucketSize += item.size
            }
            if !bucket.isEmpty {
                blobs.append(BlobPlan(id: Self.stableId(bucket), items: bucket, prefix: prefix))
            }
        }

        // Upload the blob holding the newest/most-precious file first. Each blob's items are already ordered,
        // so its lead item is its claim on priority.
        return blobs.sorted { a, b in Self.newestFirst(a.items[0], b.items[0]) }
    }
}
