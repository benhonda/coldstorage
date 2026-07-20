import Testing
import Foundation
@testable import ColdStorageCore

private func item(_ id: String, size: Int, created: TimeInterval, favorite: Bool = false, dir: String = "d") -> IngestItem {
    IngestItem(id: id, relativePath: "\(dir)/\(id)", size: size, content: .sha256(id),
               createdAt: Date(timeIntervalSince1970: created), isFavorite: favorite,
               open: { AsyncThrowingStream { $0.finish() } })
}

@Suite struct BlobPlannerTests {
    @Test func largeFilesGetTheirOwnBlob() {
        let big = item("big", size: 500 << 20, created: 1)              // > smallFileMax
        let small = item("small", size: 1 << 20, created: 2)
        let blobs = BlobPlanner().plan([big, small], prefix: .dev)
        #expect(blobs.contains { $0.items.map(\.id) == ["big"] })
    }

    @Test func favoritesAndNewestFirst() {
        let old = item("old", size: 1 << 20, created: 1)
        let new = item("new", size: 1 << 20, created: 100)
        let fav = item("fav", size: 1 << 20, created: 1, favorite: true)
        let blobs = BlobPlanner().plan([old, new, fav], prefix: .dev)
        let order = blobs.flatMap { $0.items.map(\.id) }
        #expect(order.first == "fav")                                              // favorite leads
        #expect(order.firstIndex(of: "new")! < order.firstIndex(of: "old")!)       // newer before older
    }

    @Test func blobIdsAreDeterministic() {                // the resume guarantee: same files → same id
        let a = item("a", size: 1 << 20, created: 1)
        let b = item("b", size: 1 << 20, created: 2)
        #expect(BlobPlanner().plan([a, b], prefix: .dev).map(\.id) == BlobPlanner().plan([a, b], prefix: .dev).map(\.id))
    }

    /// `plan` is a PURE function of the items handed to it, and re-grouping when the item set changes is
    /// correct behaviour for it — a bucket really is different once a new neighbour arrives. Keeping
    /// already-archived files OUT of that item set is the engine's job, not the planner's; the guarantee
    /// that a deposit doesn't re-upload the library therefore lives in `IncrementalDepositTests`.
    @Test func aChangedItemSetLegitimatelyRegroups() {
        let library = (0..<3).map { item("f\($0)", size: 1 << 20, created: TimeInterval($0), dir: "Pictures") }
        let before = Set(BlobPlanner().plan(library, prefix: .dev).map(\.id))
        let after = Set(BlobPlanner().plan(library + [item("new", size: 1 << 20, created: 1000, dir: "Pictures")], prefix: .dev).map(\.id))
        #expect(before != after)   // documents WHY the engine must filter, rather than asserting the planner is wrong
    }
}
