import XCTest
import Foundation
@testable import ColdStorageCore

private func item(_ id: String, size: Int, created: TimeInterval, favorite: Bool = false, dir: String = "d") -> IngestItem {
    IngestItem(id: id, relativePath: "\(dir)/\(id)", size: size, contentHash: id,
               createdAt: Date(timeIntervalSince1970: created), isFavorite: favorite,
               open: { AsyncThrowingStream { $0.finish() } })
}

final class BlobPlannerTests: XCTestCase {
    func testLargeFilesGetTheirOwnBlob() {
        let big = item("big", size: 500 << 20, created: 1)              // > smallFileMax
        let small = item("small", size: 1 << 20, created: 2)
        let blobs = BlobPlanner().plan([big, small])
        XCTAssertTrue(blobs.contains { $0.items.map(\.id) == ["big"] })
    }

    func testFavoritesAndNewestFirst() {
        let old = item("old", size: 1 << 20, created: 1)
        let new = item("new", size: 1 << 20, created: 100)
        let fav = item("fav", size: 1 << 20, created: 1, favorite: true)
        let blobs = BlobPlanner().plan([old, new, fav])
        let order = blobs.flatMap { $0.items.map(\.id) }
        XCTAssertEqual(order.first, "fav")            // favorite leads
        XCTAssertLessThan(order.firstIndex(of: "new")!, order.firstIndex(of: "old")!)  // newer before older
    }

    func testBlobIdsAreDeterministic() {                // the resume guarantee: same files → same id
        let a = item("a", size: 1 << 20, created: 1)
        let b = item("b", size: 1 << 20, created: 2)
        XCTAssertEqual(BlobPlanner().plan([a, b]).map(\.id), BlobPlanner().plan([a, b]).map(\.id))
    }
}
