import Testing
import Foundation
@testable import ColdStorageCore

/// **Batching exists to keep the number of S3 objects small**, because every blob costs four sequential
/// round trips — `CreateMultipartUpload`, `UploadPart`, `CompleteMultipartUpload`, and a `HEAD` to verify.
/// Fragment a deposit into one blob per file and the upload becomes latency-bound: a 1000-file deposit pays
/// thousands of round trips, one after another, and takes minutes regardless of how fast the link is.
///
/// That is exactly what a real 100-file deposit did on 2026-07-14 — ~14 blobs, most of them under 1 MiB —
/// because the planner ordered by DATE and then broke the batch whenever the folder changed. Dates interleave
/// folders, so the bucket was flushed almost every item and never filled.
@Suite struct BlobBatchingTests {

    private func item(_ path: String, size: Int, ageDays: Int) -> IngestItem {
        IngestItem(id: path, relativePath: path, size: size, content: .sha256("h-\(path)"),
                   createdAt: Date(timeIntervalSince1970: 1_700_000_000 - Double(ageDays) * 86_400),
                   isFavorite: false,
                   open: { AsyncThrowingStream { $0.finish() } })
    }

    /// The regression. Small files from a handful of folders, with dates INTERLEAVED across those folders —
    /// i.e. an ordinary photo/document drop. They must batch by folder, not shatter into a blob apiece.
    @Test func filesFromAFewFoldersBatchIntoAFewBlobs() {
        let folders = ["Trip/Rome", "Trip/Paris", "Docs", "Docs/Receipts"]
        // 100 files, round-robin across folders so consecutive dates come from DIFFERENT folders.
        let items = (0..<100).map { i in
            item("\(folders[i % folders.count])/f\(i).jpg", size: 200_000, ageDays: i)
        }

        let blobs = BlobPlanner().plan(items, prefix: .dev)

        // 4 folders × 20 MB total — nowhere near the 1 GiB cap, so this is one blob per folder.
        #expect(blobs.count == folders.count,
                "100 small files across \(folders.count) folders produced \(blobs.count) blobs — each one is 4 S3 round trips")
        #expect(blobs.allSatisfy { !$0.items.isEmpty })
        #expect(blobs.flatMap(\.items).count == 100)          // nothing dropped
        #expect(Set(blobs.flatMap { $0.items.map(\.id) }).count == 100)   // nothing duplicated
    }

    /// Locality is the point: a folder-restore should pull few objects, so a blob must not mix folders.
    @Test func aBlobNeverMixesFolders() {
        let items = (0..<40).map { i in item("\(i % 4 == 0 ? "A" : "B")/f\(i).bin", size: 1000, ageDays: i) }
        for blob in BlobPlanner().plan(items, prefix: .dev) {
            let folders = Set(blob.items.map { ($0.relativePath as NSString).deletingLastPathComponent })
            #expect(folders.count == 1, "a blob spans \(folders) — a folder-restore would over-fetch")
        }
    }

    /// The cap still holds: a folder with more than `blobCap` of files splits into several blobs.
    @Test func aFolderBiggerThanTheCapSplits() {
        let planner = BlobPlanner(blobCap: 1_000_000, smallFileMax: 64 << 20)
        let items = (0..<10).map { item("Big/f\($0).bin", size: 300_000, ageDays: $0) }   // 3 MB into a 1 MB cap
        let blobs = planner.plan(items, prefix: .dev)

        #expect(blobs.count == 4)                              // 3 × 300 KB per blob, then the remainder
        #expect(blobs.allSatisfy { $0.items.reduce(0) { $0 + $1.size } <= 1_000_000 })
        #expect(blobs.flatMap(\.items).count == 10)
    }

    /// Recency survives the regrouping — "your last 30 days are safe" is a promise about the ORDER blobs are
    /// uploaded in, so the blob holding the newest file still goes first.
    @Test func theNewestFilesStillGoUpFirst() {
        let items = [
            item("Old/ancient.jpg", size: 1000, ageDays: 900),
            item("New/today.jpg", size: 1000, ageDays: 0),
            item("Mid/lastyear.jpg", size: 1000, ageDays: 300),
        ]
        let blobs = BlobPlanner().plan(items, prefix: .dev)
        #expect(blobs.first?.items.first?.relativePath == "New/today.jpg")
        #expect(blobs.last?.items.first?.relativePath == "Old/ancient.jpg")
    }

    /// Large files still go solo (their own blob = a determinate progress bar + no over-fetch on restore).
    @Test func largeFilesStillGetTheirOwnBlob() {
        let items = [
            item("Vids/big.mov", size: 200 << 20, ageDays: 1),   // > smallFileMax
            item("Vids/a.jpg", size: 1000, ageDays: 2),
            item("Vids/b.jpg", size: 1000, ageDays: 3),
        ]
        let blobs = BlobPlanner().plan(items, prefix: .dev)
        let solo = blobs.first { $0.items.contains { $0.relativePath == "Vids/big.mov" } }
        #expect(solo?.items.count == 1)                          // not batched with its small neighbours
        #expect(blobs.count == 2)                                // the solo + one batch of the two small ones
    }
}
