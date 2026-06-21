import Testing
import Foundation
@testable import ColdStorageCore

private func item(_ id: String, size: Int, created: TimeInterval, favorite: Bool = false, dir: String = "d") -> IngestItem {
    IngestItem(id: id, relativePath: "\(dir)/\(id)", size: size, contentHash: id,
               createdAt: Date(timeIntervalSince1970: created), isFavorite: favorite,
               open: { AsyncThrowingStream { $0.finish() } })
}

@Suite struct BlobPlannerTests {
    @Test func largeFilesGetTheirOwnBlob() {
        let big = item("big", size: 500 << 20, created: 1)              // > smallFileMax
        let small = item("small", size: 1 << 20, created: 2)
        let blobs = BlobPlanner().plan([big, small])
        #expect(blobs.contains { $0.items.map(\.id) == ["big"] })
    }

    @Test func favoritesAndNewestFirst() {
        let old = item("old", size: 1 << 20, created: 1)
        let new = item("new", size: 1 << 20, created: 100)
        let fav = item("fav", size: 1 << 20, created: 1, favorite: true)
        let blobs = BlobPlanner().plan([old, new, fav])
        let order = blobs.flatMap { $0.items.map(\.id) }
        #expect(order.first == "fav")                                              // favorite leads
        #expect(order.firstIndex(of: "new")! < order.firstIndex(of: "old")!)       // newer before older
    }

    @Test func blobIdsAreDeterministic() {                // the resume guarantee: same files → same id
        let a = item("a", size: 1 << 20, created: 1)
        let b = item("b", size: 1 << 20, created: 2)
        #expect(BlobPlanner().plan([a, b]).map(\.id) == BlobPlanner().plan([a, b]).map(\.id))
    }
}
