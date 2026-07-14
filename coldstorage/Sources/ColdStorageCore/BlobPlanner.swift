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

    /// `prefix` namespaces every produced blob's S3 key (a signed-in user's `blobs/<identity-id>`). It does
    /// NOT affect the content-derived blob `id` — only where the object lands — so the same files
    /// resume/dedup identically regardless of which user owns them.
    public func plan(_ items: [IngestItem], prefix: VaultPrefix) -> [BlobPlan] {
        let ordered = items.sorted { a, b in
            if a.isFavorite != b.isFavorite { return a.isFavorite }                       // favorites first
            let (ca, cb) = (a.createdAt ?? .distantPast, b.createdAt ?? .distantPast)
            if ca != cb { return ca > cb }                                                // newest first
            return a.id < b.id                                                            // stable tiebreaker → deterministic
        }
        var blobs: [BlobPlan] = []
        var bucket: [IngestItem] = []; var bucketSize = 0; var bucketDir = ""

        func flush() {
            guard !bucket.isEmpty else { return }
            blobs.append(BlobPlan(id: Self.stableId(bucket), items: bucket, prefix: prefix))
            bucket = []; bucketSize = 0; bucketDir = ""
        }
        for item in ordered {
            if item.size > smallFileMax { blobs.append(BlobPlan(id: Self.stableId([item]), items: [item], prefix: prefix)); continue }
            let dir = (item.relativePath as NSString).deletingLastPathComponent
            if bucketSize + item.size > blobCap || (!bucket.isEmpty && dir != bucketDir) { flush() }
            if bucket.isEmpty { bucketDir = dir }
            bucket.append(item); bucketSize += item.size
        }
        flush()
        return blobs
    }
}
