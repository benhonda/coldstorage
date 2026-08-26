import Testing
import Foundation
import Csqlite3
@testable import ColdStorageCore

/// Opening an EXISTING journal from before failures had a kind or a batch (2026-08-26).
///
/// Those rows are the ones the user is looking at — a 56k-file drop interrupted on an older build, say —
/// so they must come through legible: the sentence the old daemon wrote onto `error` recovered into a
/// `FileFailureKind` (and cleared, since it was never developer detail), and every failed row no watched
/// folder covers gathered into one batch the Uploads page can show. Written with raw SQLite on purpose —
/// `Journal` can no longer produce this shape.
@Suite struct FailureKindMigrationTests {
    private func legacyJournal(_ rows: [(id: String, status: String, error: String?)],
                               mounts: [String] = []) throws -> String {
        let path = FileManager.default.temporaryDirectory
            .appendingPathComponent("cs-legacy-fk-\(ProcessInfo.processInfo.processIdentifier)-\(UUID().uuidString).sqlite").path
        var handle: OpaquePointer?
        try #require(sqlite3_open_v2(path, &handle, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE, nil) == SQLITE_OK)
        defer { sqlite3_close(handle) }
        func exec(_ sql: String) { #expect(sqlite3_exec(handle, sql, nil, nil, nil) == SQLITE_OK, "\(sql)") }
        exec("""
            CREATE TABLE files(
              id TEXT PRIMARY KEY, relativePath TEXT NOT NULL, size INTEGER NOT NULL,
              contentHash TEXT NOT NULL, status TEXT NOT NULL, blobId TEXT,
              "offset" INTEGER, length INTEGER, firstFrame INTEGER, plaintextSha256 TEXT, error TEXT,
              createdAt INTEGER, deletedAt INTEGER, lastAttemptAt INTEGER, sourcePath TEXT);
            CREATE TABLE sources(
              id TEXT PRIMARY KEY, kind TEXT NOT NULL, path TEXT, addedAt INTEGER NOT NULL DEFAULT 0,
              mountPath TEXT NOT NULL DEFAULT '', paused INTEGER NOT NULL DEFAULT 0,
              lastScanAt INTEGER, error TEXT);
            CREATE TABLE deposits(
              id TEXT PRIMARY KEY, kind TEXT NOT NULL, src TEXT NOT NULL, dest TEXT NOT NULL,
              conflicts TEXT NOT NULL DEFAULT '{}', excludeExtra TEXT NOT NULL DEFAULT '',
              createdAt INTEGER NOT NULL);
            """)
        for r in rows {
            let err = r.error.map { "'\($0.replacingOccurrences(of: "'", with: "''"))'" } ?? "NULL"
            exec("INSERT INTO files(id, relativePath, size, contentHash, status, error, lastAttemptAt) VALUES('\(r.id)', '\(r.id)', 1, 'h', '\(r.status)', \(err), 100)")
        }
        for m in mounts { exec("INSERT INTO sources(id, kind, path, mountPath) VALUES('/\(m)', 'folder', '/\(m)', '\(m)')") }
        return path
    }

    @Test func oldSentencesBecomeKindsAndOrphansGetABatch() throws {
        let path = try legacyJournal([
            (id: "Drop/a.jpg", status: "failed", error: "Upload didn\u{2019}t finish. Add this to your backup again to complete it."),
            (id: "Drop/b.jpg", status: "failed", error: "Upload didn\u{2019}t finish."),
            (id: "Drop/c.jpg", status: "failed", error: "Couldn\u{2019}t find this file on disk. Reconnect the drive it\u{2019}s on and try again, or use Locate\u{2026} to point at it."),
            (id: "Drop/d.jpg", status: "failed", error: "Stopped before it finished uploading."),
            (id: "Drop/e.jpg", status: "failed", error: "S3 AccessDenied: forbidden"),
            (id: "Camera/f.jpg", status: "failed", error: "S3 AccessDenied: forbidden"),
            (id: "Camera/ok.jpg", status: "archived", error: nil),
        ], mounts: ["Camera"])
        let j = try Journal(path: path)
        let rows = Dictionary(uniqueKeysWithValues: try j.listFiles().map { ($0.id, $0) })
        // Both wordings of the interrupted sentence → one kind, and the sentence is gone (the app says it now).
        #expect(rows["Drop/a.jpg"]?.failureKind == .interrupted && rows["Drop/a.jpg"]?.error == nil)
        #expect(rows["Drop/b.jpg"]?.failureKind == .interrupted)
        #expect(rows["Drop/c.jpg"]?.failureKind == .missingSource && rows["Drop/c.jpg"]?.error == nil)
        #expect(rows["Drop/d.jpg"]?.failureKind == .stopped)
        // A real fault keeps its message: that IS the developer detail.
        #expect(rows["Drop/e.jpg"]?.failureKind == .permanent && rows["Drop/e.jpg"]?.error == "S3 AccessDenied: forbidden")
        #expect(rows["Camera/ok.jpg"]?.failureKind == nil)

        // The five under no watched folder share one batch; the watched folder's own failure stays its own.
        let batches = try j.listDeposits()
        #expect(batches.count == 1)
        let batch = try #require(batches.first)
        #expect(batch.state == .done && batch.mode == .retry && batch.src == ["Drop"] && batch.createdAt == 100)
        for id in ["Drop/a.jpg", "Drop/b.jpg", "Drop/c.jpg", "Drop/d.jpg", "Drop/e.jpg"] { #expect(rows[id]?.depositId == batch.id) }
        #expect(rows["Camera/f.jpg"]?.depositId == nil)
        #expect(rows["Camera/ok.jpg"]?.depositId == nil)

        // Idempotent: a second open changes nothing — one batch, same kinds.
        let again = try Journal(path: path)
        #expect(try again.listDeposits().map(\.id) == [batch.id])
        #expect(try again.listFiles().first { $0.id == "Drop/a.jpg" }?.failureKind == .interrupted)
    }

    /// The previous build's "Try again" recorded a deposit of `kind='retry'` — a list of file ids. A retry
    /// is an action on a batch now, so that row means nothing: it is removed rather than left as a row no
    /// build can read (and no page can show).
    @Test func aLegacyRetryDepositRowIsRemoved() throws {
        let path = try legacyJournal([])
        var handle: OpaquePointer?
        try #require(sqlite3_open_v2(path, &handle, SQLITE_OPEN_READWRITE, nil) == SQLITE_OK)
        #expect(sqlite3_exec(handle, "INSERT INTO deposits(id, kind, src, dest, createdAt) VALUES('r1', 'retry', 'x\ny', '', 5), ('d1', 'files', '/x', '', 6)", nil, nil, nil) == SQLITE_OK)
        sqlite3_close(handle)
        let j = try Journal(path: path)
        #expect(try j.listDeposits().map(\.id) == ["d1"])
    }

    /// A deposit row that was still owed when the daemon was updated is still owed after: the new columns'
    /// defaults ARE "pending, ingest".
    @Test func anOwedDepositStaysOwedAcrossTheUpgrade() throws {
        let path = try legacyJournal([])
        var handle: OpaquePointer?
        #expect(sqlite3_open_v2(path, &handle, SQLITE_OPEN_READWRITE, nil) == SQLITE_OK)
        #expect(sqlite3_exec(handle, "INSERT INTO deposits(id, kind, src, dest, createdAt) VALUES('d1', 'files', '/x', '', 5)", nil, nil, nil) == SQLITE_OK)
        sqlite3_close(handle)
        let j = try Journal(path: path)
        let d = try #require(try j.pendingDeposits().first)
        #expect(d.id == "d1" && d.state == .pending && d.mode == .ingest && d.finishedAt == nil)
    }
}
