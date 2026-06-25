import Testing
import Foundation
@testable import ColdStorageCore

/// The excludes registry persists what the scan filters by (the SSOT). These exercise the real SQLite
/// path: fresh-journal default seeding, add/remove/list, idempotent re-add, and the seed-once contract
/// (a user who clears the defaults doesn't get them re-seeded on reopen).
@Suite struct JournalExcludesTests {
    private func tempPath() -> String {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("cs-exc-\(ProcessInfo.processInfo.processIdentifier)-\(UUID().uuidString).sqlite").path
    }

    @Test func freshJournalSeedsDefaults() throws {
        let j = try Journal(path: tempPath())
        #expect(try j.listExcludes().sorted() == Journal.defaultExcludes.sorted())
    }

    @Test func addListRemove() throws {
        let j = try Journal(path: tempPath())
        try j.addExclude("*.log")
        #expect(try j.listExcludes().contains("*.log"))
        try j.addExclude("*.log")                                       // idempotent on the pattern text
        #expect(try j.listExcludes().filter { $0 == "*.log" }.count == 1)
        try j.removeExclude("*.log")
        #expect(try !j.listExcludes().contains("*.log"))
    }

    @Test func defaultsAreSeededOnceNotReimposed() throws {
        let path = tempPath()
        do {
            let j = try Journal(path: path)
            for p in try j.listExcludes() { try j.removeExclude(p) }    // user clears every default
            #expect(try j.listExcludes().isEmpty)
        }
        // Reopen the SAME journal file: the excludes table already exists, so defaults are NOT re-seeded.
        let reopened = try Journal(path: path)
        #expect(try reopened.listExcludes().isEmpty)
    }
}
