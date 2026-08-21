import Testing
import Foundation
@testable import ColdStorageCore

/// **The worst silent failure in the product (found 2026-08-21).** `LocalDirSource.walk` opened with
/// `guard let en = fm.enumerator(at: root, …) else { return [] }`. A watched folder that can't be read —
/// unmounted external drive, folder deleted or renamed, macOS permission revoked — makes that enumerator
/// nil, and an empty result is INDISTINGUISHABLE from "the folder is fine and has nothing new."
///
/// So the run completed cleanly, published `runFinished`, and Settings rendered a green **"Up to date"**
/// badge — every five minutes, indefinitely, for a backup that had stopped happening. The one failure a
/// backup product must never hide, hidden by one line.
///
/// These use REAL directories rather than a fake source, because the bug lived in the FileManager call: a
/// stubbed source would have proven only that the stub returns what it was told to.
@Suite struct SourceHealthTests {
    private func tempDir() -> URL {
        let d = FileManager.default.temporaryDirectory
            .appendingPathComponent("cs-src-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }

    @Test func aVanishedFolderThrowsInsteadOfLookingEmpty() async throws {
        let dir = tempDir()
        try Data("hi".utf8).write(to: dir.appendingPathComponent("a.txt"))
        let source = LocalDirSource(root: dir)
        #expect(try source.walk().count == 1, "sanity: it works while the folder is there")

        try FileManager.default.removeItem(at: dir)   // the unplugged drive

        #expect(throws: ColdStorageError.self) { try source.walk() }
    }

    /// The distinction the copy depends on: "it isn't there" and "we can't read it" need different things
    /// from the user — plug the drive back in vs. grant this Mac access — so the message must say which.
    @Test func theMessageNamesWhichProblemItIs() {
        let gone = LocalDirSource(root: URL(fileURLWithPath: "/definitely/not/here-\(UUID().uuidString)"))
        do {
            _ = try gone.walk()
            Issue.record("a missing folder must not walk successfully")
        } catch let e as ColdStorageError {
            #expect("\(e)".contains("isn't there"))
        } catch {
            Issue.record("wrong error type: \(error)")
        }
    }

    /// An unreadable folder is almost always a drive that will come back, so the next pass must retry it.
    /// Classifying it permanent (the default for every other `ColdStorageError`) would mean one unplug
    /// permanently stops a folder backing up.
    @Test func anUnreadableFolderIsTransientSoTheNextPassRetries() {
        let kind = FailureKind.classify(ColdStorageError.sourceUnreadable("gone"))
        #expect(!kind.isPermanent)
    }

    /// **Isolation.** Making the walk throw was only half the fix: `MultiSource` stops at the first throw,
    /// so on its own it would have turned a silent partial failure into a loud TOTAL one — one unplugged
    /// drive halting every other folder's backup. This is the half that prevents that.
    @Test func oneBrokenFolderDoesNotStopTheOthers() async throws {
        let good = tempDir()
        defer { try? FileManager.default.removeItem(at: good) }
        try Data("hi".utf8).write(to: good.appendingPathComponent("keep.txt"))
        let missing = URL(fileURLWithPath: "/definitely/not/here-\(UUID().uuidString)")

        let faults = FaultBox()
        let combined = MultiSource([
            ScanReportingSource(LocalDirSource(root: missing)) { faults.record("broken", $0) },
            ScanReportingSource(LocalDirSource(root: good)) { faults.record("good", $0) },
        ])

        let items = try await combined.enumerate()

        #expect(items.count == 1, "the healthy folder still backs up")
        #expect(faults.error(for: "broken") != nil, "and the broken one is reported, not swallowed")
        #expect(faults.error(for: "good") == nil, "success reports success — that's what clears a stale fault")
    }

    /// Every pass reports, whatever happened — the property the whole freshness idea rests on. A clock that
    /// only ticks on success goes quiet exactly when something is wrong.
    @Test func theOutcomeIsReportedOnSuccessToo() async throws {
        let dir = tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let faults = FaultBox()
        _ = try await ScanReportingSource(LocalDirSource(root: dir)) { faults.record("s", $0) }.enumerate()
        #expect(faults.reported(for: "s"), "an empty-but-healthy folder still reports that it was scanned")
    }

    /// The end of the chain: reporting is only worth anything because it lands somewhere that survives the
    /// app being closed. This is what makes the difference between the old ephemeral `error` bus event —
    /// gone the instant nobody was listening — and a folder that can still tell you it stopped on the 3rd.
    @Test func theScanOutcomeIsDurableAndSelfHealing() throws {
        let dir = tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let j = try Journal(path: dir.appendingPathComponent("journal.sqlite").path)
        try j.addSource(SourceRow(id: "/Volumes/Photos", kind: .folder, path: "/Volumes/Photos",
                                  mountPath: "Photos"))
        let read = { try #require(try j.listSources().first) }

        #expect(try read().lastScanAt == nil, "never scanned yet — not backfilled into a claim we can't make")

        try j.markSourceScanned("/Volumes/Photos", error: "/Volumes/Photos isn't there")
        #expect(try read().error == "/Volumes/Photos isn't there")
        #expect(try read().lastScanAt != nil, "a failed scan is still a scan — the clock moves either way")

        try j.markSourceScanned("/Volumes/Photos", error: nil)   // drive plugged back in
        #expect(try read().error == nil, "a fault is history the moment the folder works again")
    }
}

/// Collects `ScanReportingSource` callbacks from the concurrent context they fire in.
private final class FaultBox: @unchecked Sendable {
    private let lock = NSLock()
    private var seen: [String: Error?] = [:]
    func record(_ id: String, _ error: Error?) { lock.withLock { seen[id] = error } }
    func reported(for id: String) -> Bool { lock.withLock { seen.index(forKey: id) != nil } }
    func error(for id: String) -> Error? { lock.withLock { seen[id] ?? nil } }
}
