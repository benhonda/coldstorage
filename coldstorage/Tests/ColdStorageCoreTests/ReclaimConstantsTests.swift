import Testing
import Foundation
@testable import ColdStorageCore

/// **The constants Swift, Terraform, the Taskfile and the UI all have to agree on.**
///
/// Space reclamation is a handshake between four components that never run together: the daemon writes a
/// tag, a bucket lifecycle rule (Terraform) expires objects carrying that tag, `daemon:gate-test` proves
/// the tag can land on cold data, and the app's delete copy promises the user a date. Every one of those
/// used to spell the values itself, and a mismatch was **silent in the worst direction** — the object gets
/// tagged, the rule never matches, the journal credits the space back, and the bytes bill for ever with
/// nothing anywhere raising a hand.
///
/// The root `reclaim.constants.json` is now the one source. Terraform, the Taskfile and the UI read it
/// directly and so cannot drift. Swift can't: these are compile-time constants in a binary that ships
/// without the repo. So the literals stay, and this suite is what makes them safe — it is the seam where
/// Swift is checked against the file, and it fails the build rather than production.
///
/// If a test here fails, the fix is always the same direction: **edit the JSON, then match the Swift to
/// it.** Editing the Swift to match a stale JSON re-opens the exact hole.
@Suite struct ReclaimConstantsTests {

    private struct Constants: Decodable {
        let reapTagKey: String
        let reapTagValue: String
        let minimumStorageDays: Int
    }

    /// Located from `#filePath` — the compile-time absolute path of THIS file — rather than `Bundle.module`.
    /// A bundled copy would be a copy, which is the thing being tested against; and the daemon deliberately
    /// ships as a bare Mach-O inside the `.app` (no resource bundle travels with it), so a resource here
    /// would prove agreement with a file production never reads.
    private func load() throws -> Constants {
        let repoRoot = URL(fileURLWithPath: #filePath)      // …/coldstorage/Tests/ColdStorageCoreTests/this.swift
            .deletingLastPathComponent()                    // …/ColdStorageCoreTests
            .deletingLastPathComponent()                    // …/Tests
            .deletingLastPathComponent()                    // …/coldstorage
            .deletingLastPathComponent()                    // repo root
        let url = repoRoot.appendingPathComponent("reclaim.constants.json")
        let data = try Data(contentsOf: url)
        return try JSONDecoder().decode(Constants.self, from: data)
    }

    /// Guards the path arithmetic above, so a moved test file fails as "the SSOT is missing" instead of
    /// quietly taking every other test in this suite down with an unreadable-file error.
    @Test func theSSOTIsWhereWeThinkItIs() throws {
        #expect(throws: Never.self) { try load() }
    }

    /// The tag the daemon writes must be the tag the lifecycle rule filters on. Both halves: S3 matches a
    /// tag filter on the KEY/VALUE PAIR, so a drifted value breaks reclamation as completely as a drifted key.
    @Test func theReapTagMatchesTheSSOT() throws {
        let c = try load()
        #expect(S3Store.reapTagKey == c.reapTagKey,
                "S3Store.reapTagKey is '\(S3Store.reapTagKey)' but reclaim.constants.json says '\(c.reapTagKey)' — the daemon would tag objects the bucket's lifecycle rule ignores, and the bytes would bill for ever.")
        #expect(S3Store.reapTagValue == c.reapTagValue,
                "S3Store.reapTagValue is '\(S3Store.reapTagValue)' but reclaim.constants.json says '\(c.reapTagValue)' — a tag filter matches on the pair, so this breaks reclamation exactly as the key would.")
    }

    /// The journal credits the user their space back at `minimumStorageDays`, on the promise that AWS has
    /// stopped charging us by then — which is only true if the lifecycle rule expires on the SAME number.
    /// Crediting earlier than the rule expires is the churn hole: free space we are still paying for.
    @Test func theMinimumStorageWindowMatchesTheSSOT() throws {
        let c = try load()
        #expect(Journal.minimumStorageDays == c.minimumStorageDays,
                "Journal.minimumStorageDays is \(Journal.minimumStorageDays) but reclaim.constants.json says \(c.minimumStorageDays) — the credit and the bucket's expiry would run on different clocks, handing back space we still pay for.")
    }
}
