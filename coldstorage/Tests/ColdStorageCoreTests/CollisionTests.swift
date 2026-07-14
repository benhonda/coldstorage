import Testing
import Foundation
@testable import ColdStorageCore

/// Finder-style deposit collision handling. `CollisionResolvingSource` decorates a deposit source so the
/// user's per-file Keep Both / Replace / Skip choice is honored deterministically — no silent de-duping.
/// These exercise the pure resolution + name-uniquify logic against a fake inner source; the daemon wiring
/// (previewDeposit + threading) is covered by the live IPC tasks.
@Suite struct CollisionTests {
    /// A trivial source that just replays canned items (one blob's worth) — stands in for an
    /// ExplicitPathsSource/PhotoDepositSource enumerate() without touching disk or PhotoKit.
    struct FakeSource: IngestSource {
        let items: [IngestItem]
        func enumerate() async throws -> [IngestItem] { items }
    }

    private func item(_ path: String) -> IngestItem {
        IngestItem(id: path, relativePath: path, size: 1, content: .sha256("h-\(path)"), createdAt: nil,
                   isFavorite: false, open: { AsyncThrowingStream { c in c.yield(Data("x".utf8)); c.finish() } })
    }

    // MARK: - uniquify (pure)

    @Test func uniquifyAppendsFinderStyleSuffix() {
        // First free " 2"; if " 2" is taken, " 3", and so on. Extension preserved; dir preserved.
        #expect(CollisionResolvingSource.uniquify("Photos/IMG_8114.HEIC", taken: ["Photos/IMG_8114.HEIC"]) == "Photos/IMG_8114 2.HEIC")
        #expect(CollisionResolvingSource.uniquify("Photos/IMG_8114.HEIC",
                                                  taken: ["Photos/IMG_8114.HEIC", "Photos/IMG_8114 2.HEIC"]) == "Photos/IMG_8114 3.HEIC")
        #expect(CollisionResolvingSource.uniquify("notes.txt", taken: ["notes.txt"]) == "notes 2.txt")        // root, no dir prefix
        #expect(CollisionResolvingSource.uniquify("README", taken: ["README"]) == "README 2")                 // no extension
        #expect(CollisionResolvingSource.uniquify("a/.gitignore", taken: ["a/.gitignore"]) == "a/.gitignore 2") // leading dot = no ext
    }

    // MARK: - resolution policies

    @Test func skipDropsCollidingItemsOnly() async throws {
        let src = FakeSource(items: [item("F/a.jpg"), item("F/b.jpg")])
        let resolved = try await CollisionResolvingSource(
            inner: src, existing: ["F/a.jpg"], conflicts: ["F/a.jpg": .skip]).enumerate()
        #expect(resolved.map(\.relativePath) == ["F/b.jpg"])   // the new file stays, the skipped one is gone
    }

    @Test func replacePassesThroughUnchanged() async throws {
        let src = FakeSource(items: [item("F/a.jpg")])
        let resolved = try await CollisionResolvingSource(
            inner: src, existing: ["F/a.jpg"], conflicts: ["F/a.jpg": .replace]).enumerate()
        #expect(resolved.map(\.relativePath) == ["F/a.jpg"])   // same path → upsert overwrites the existing row
        #expect(resolved.first?.id == "F/a.jpg")
    }

    @Test func keepBothRenamesAvoidingExistingAndBatch() async throws {
        // Two incoming files collide with the existing "F/a.jpg"; both Keep Both. The first becomes " 2",
        // the second must NOT also pick " 2" — it dodges the just-assigned name AND the existing row.
        let src = FakeSource(items: [item("F/a.jpg"), item("F/a.jpg")])
        let resolved = try await CollisionResolvingSource(
            inner: src, existing: ["F/a.jpg"], conflicts: ["F/a.jpg": .keepBoth]).enumerate()
        #expect(resolved.map(\.relativePath) == ["F/a 2.jpg", "F/a 3.jpg"])
        #expect(resolved.map(\.id) == ["F/a 2.jpg", "F/a 3.jpg"])   // id re-keyed with the path (copies, not moves)
    }

    @Test func keepBothDodgesANonCollidingSiblingInTheSameDrop() async throws {
        // A drop carries both "F/a.jpg" (collides → keepBoth) and a brand-new "F/a 2.jpg". The keepBoth
        // rename must skip past "F/a 2.jpg" (a sibling that keeps its name this run) to "F/a 3.jpg".
        let src = FakeSource(items: [item("F/a.jpg"), item("F/a 2.jpg")])
        let resolved = try await CollisionResolvingSource(
            inner: src, existing: ["F/a.jpg"], conflicts: ["F/a.jpg": .keepBoth]).enumerate()
        #expect(Set(resolved.map(\.relativePath)) == ["F/a 3.jpg", "F/a 2.jpg"])
    }

    @Test func itemsWithoutAPolicyPassThrough() async throws {
        let src = FakeSource(items: [item("F/new.jpg")])
        let resolved = try await CollisionResolvingSource(
            inner: src, existing: [], conflicts: [:]).enumerate()
        #expect(resolved.map(\.relativePath) == ["F/new.jpg"])
    }
}
