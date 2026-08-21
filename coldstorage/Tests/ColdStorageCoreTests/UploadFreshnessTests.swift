import Testing
import Foundation
@testable import ColdStorageCore

/// **The upload half of the honesty pair (2026-08-21).** The tree renders a `planned` file as "Uploading".
/// Two of the three ways an upload can stop getting anywhere were already given journal truth — a permanent
/// fault and an over-quota refusal both call `markFilesFailed`, precisely because a row stuck reading
/// "Uploading" forever is a lie. The third, a TRANSIENT fault, touched the journal not at all: it went out
/// as a `blobFailed` bus event and nowhere else, so a file whose blob kept failing sat at `planned` with no
/// record and no clock — and if the app wasn't open when the event fired, no trace existed anywhere.
///
/// `recordFileFault` + `files.lastAttemptAt` close it. These pin what each write is allowed to touch.
@Suite struct UploadFreshnessTests {
    private func journal() throws -> (j: Journal, dir: URL) {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("cs-upl-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return (try Journal(path: dir.appendingPathComponent("journal.sqlite").path), dir)
    }

    private func seed(_ j: Journal, id: String = "f1") throws {
        try j.upsert([IngestItem(id: id, relativePath: "Photos/beach.jpg", size: 2048,
                                 content: .sha256("hash-\(id)"), createdAt: nil, isFavorite: false,
                                 open: { AsyncThrowingStream { $0.finish() } })])
    }

    private func row(_ j: Journal, _ id: String = "f1") throws -> FileRow {
        try #require(try j.listFiles().first { $0.id == id })
    }

    @Test func aFreshlyScannedFileHasNeverBeenAttempted() throws {
        let f = try journal(); defer { try? FileManager.default.removeItem(at: f.dir) }
        try seed(f.j)
        // NOT backfilled: "scanned into the journal" and "the upload path tried it" are different facts.
        #expect(try row(f.j).lastAttemptAt == nil)
        #expect(try row(f.j).error == nil)
    }

    @Test func aTransientFaultRecordsWhyAndWhenWithoutCondemningTheFile() throws {
        let f = try journal(); defer { try? FileManager.default.removeItem(at: f.dir) }
        try seed(f.j)

        try f.j.recordFileFault(["f1"], error: "S3 RequestTimeout")

        let r = try row(f.j)
        #expect(r.error == "S3 RequestTimeout", "the snag is journal truth now, not just a bus event")
        #expect(r.lastAttemptAt != nil, "and it counts as an attempt — something did try")
        #expect(r.status != .failed, "transient means the run loop retries it; condemning it would strand it")
    }

    @Test func aSucceedingAttemptClearsTheSnagNote() throws {
        let f = try journal(); defer { try? FileManager.default.removeItem(at: f.dir) }
        try seed(f.j)
        try f.j.recordFileFault(["f1"], error: "S3 RequestTimeout")

        try f.j.markFileArchived("f1", blobId: "b1", offset: 0, length: 2048,
                                 firstFrame: 0, plaintextSha256: "hash-f1", size: 2048)

        let r = try row(f.j)
        #expect(r.status == .archived)
        #expect(r.error == nil, "a recorded fault is history the moment the thing succeeds")
        #expect(r.lastAttemptAt != nil)
    }

    /// The guard `markFilesFailed` documents, applied to the new write too: a later blob's snag says nothing
    /// about bytes already verified in S3, and telling someone a backup they HAVE didn't happen is the one
    /// claim this product cannot afford to get wrong.
    @Test func aTransientFaultCanNeverMarkAnAlreadyArchivedFile() throws {
        let f = try journal(); defer { try? FileManager.default.removeItem(at: f.dir) }
        try seed(f.j)
        try f.j.markFileArchived("f1", blobId: "b1", offset: 0, length: 2048,
                                 firstFrame: 0, plaintextSha256: "hash-f1", size: 2048)

        try f.j.recordFileFault(["f1"], error: "S3 RequestTimeout")

        let r = try row(f.j)
        #expect(r.status == .archived)
        #expect(r.error == nil, "an archived file carries no fault — its bytes are in S3")
    }

    @Test func recordingAFaultForNoFilesIsANoOp() throws {
        let f = try journal(); defer { try? FileManager.default.removeItem(at: f.dir) }
        try seed(f.j)
        try f.j.recordFileFault([], error: "nobody")
        #expect(try row(f.j).error == nil)
    }
}
