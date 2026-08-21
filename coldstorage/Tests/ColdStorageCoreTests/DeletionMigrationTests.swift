import Testing
import Foundation
import Csqlite3
@testable import ColdStorageCore

/// Opening an EXISTING journal written under the old scheme, where deletion was `status='deleted'`.
///
/// Two things have to happen, and neither may be assumed: tombstones must survive the move to `deletedAt`
/// with a plausible status recovered, and the phantom rows the old revive left behind — permanently
/// "uploading", unreclaimable — must be cleaned up. These vaults exist on real machines; the migration is
/// the only thing that reaches them.
@Suite struct DeletionMigrationTests {
    /// Build a pre-migration journal by hand: the old schema, with the old `deleted`/`discovered` statuses.
    /// Written with raw SQLite on purpose — `Journal` can no longer produce this shape, and a fixture that
    /// went through today's code would prove nothing about yesterday's data.
    private func legacyJournal(_ rows: [(id: String, path: String, status: String, blobId: String?)],
                               blobs: [(id: String, status: String)] = [],
                               members: [(blobId: String, fileId: String)] = []) throws -> String {
        let path = FileManager.default.temporaryDirectory
            .appendingPathComponent("cs-legacy-\(ProcessInfo.processInfo.processIdentifier)-\(UUID().uuidString).sqlite").path
        var handle: OpaquePointer?
        #expect(sqlite3_open_v2(path, &handle, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE, nil) == SQLITE_OK)
        defer { sqlite3_close(handle) }
        func exec(_ sql: String) { #expect(sqlite3_exec(handle, sql, nil, nil, nil) == SQLITE_OK, "\(sql)") }
        // The `files`/`blobs`/`blob_members` shape as it was BEFORE `deletedAt` — no such column.
        exec("""
            CREATE TABLE files(
              id TEXT PRIMARY KEY, relativePath TEXT NOT NULL, size INTEGER NOT NULL,
              contentHash TEXT NOT NULL, status TEXT NOT NULL, blobId TEXT,
              "offset" INTEGER, length INTEGER, firstFrame INTEGER, plaintextSha256 TEXT, error TEXT,
              createdAt INTEGER);
            CREATE TABLE blobs(
              id TEXT PRIMARY KEY, s3Key TEXT NOT NULL, uploadId TEXT,
              noncePrefix BLOB, wrappedDEK BLOB, status TEXT NOT NULL, archivedAt INTEGER);
            CREATE TABLE blob_members(
              blobId TEXT NOT NULL, fileId TEXT NOT NULL, ordinal INTEGER NOT NULL DEFAULT 0,
              PRIMARY KEY(blobId, fileId));
            """)
        for r in rows {
            exec("""
                INSERT INTO files(id, relativePath, size, contentHash, status, blobId)
                VALUES('\(r.id)', '\(r.path)', 1, 'h', '\(r.status)', \(r.blobId.map { "'\($0)'" } ?? "NULL"))
                """)
        }
        for b in blobs { exec("INSERT INTO blobs(id, s3Key, status) VALUES('\(b.id)', 'blobs/\(b.id)', '\(b.status)')") }
        for m in members { exec("INSERT INTO blob_members(blobId, fileId) VALUES('\(m.blobId)', '\(m.fileId)')") }
        return path
    }

    @Test func tombstonesSurviveTheMoveToDeletedAt() throws {
        let path = try legacyJournal([
            (id: "a.jpg", path: "a.jpg", status: "archived", blobId: "b1"),
            (id: "gone.jpg", path: "gone.jpg", status: "deleted", blobId: "b1"),
        ], blobs: [(id: "b1", status: "verified")],
           members: [(blobId: "b1", fileId: "a.jpg"), (blobId: "b1", fileId: "gone.jpg")])

        let j = try Journal(path: path)
        #expect(try j.listFiles().map(\.relativePath) == ["a.jpg"], "a tombstoned file came back through the migration")
        // Still deleted, and still settled — so nothing re-plans and re-uploads it.
        #expect(try j.settledFileIds() == ["a.jpg", "gone.jpg"])
        // And its recovered status is the one its blob link implies, so reviving it keeps those bytes.
        try j.reviveFiles(ids: ["gone.jpg"])
        #expect(try j.listFiles().first { $0.relativePath == "gone.jpg" }?.status == .archived)
    }

    @Test func aLegacyFolderMarkerTombstoneComesBackAsAMarker() throws {
        let path = try legacyJournal([
            (id: "folder:8B2C-DEAD", path: "Empty", status: "deleted", blobId: nil),
        ])
        let j = try Journal(path: path)
        try j.reviveFiles(ids: ["folder:8B2C-DEAD"])
        #expect(try j.listFiles().map(\.status) == [.folder])
    }

    /// THE REPAIR. `discovered` was only ever written by the old path-prefix revive, so every one of these
    /// rows is a file the user deleted that the bug brought back — visible, permanently "uploading", and
    /// holding its blob's bytes hostage because a live member blocks reclamation.
    @Test func phantomRowsFromTheReviveBugAreReDeletedAndTheirBytesFreed() throws {
        let path = try legacyJournal([
            (id: "Photos/a.jpg", path: "Photos/a.jpg", status: "archived", blobId: "b1"),
            (id: "Photos/b.jpg", path: "Photos/b.jpg", status: "discovered", blobId: nil),  // phantom
            (id: "Photos/c.jpg", path: "Photos/c.jpg", status: "discovered", blobId: nil),  // phantom
        ], blobs: [(id: "b1", status: "verified"), (id: "b2", status: "verified")],
           members: [(blobId: "b1", fileId: "Photos/a.jpg"),
                     (blobId: "b2", fileId: "Photos/b.jpg"), (blobId: "b2", fileId: "Photos/c.jpg")])

        let j = try Journal(path: path)
        #expect(try j.listFiles().map(\.relativePath) == ["Photos/a.jpg"],
                "phantom rows survived — they'd sit on 'uploading' for ever, since nothing on disk feeds them")
        #expect(try j.summary().total == 1, "the file count still includes rows that can never be archived")
        #expect(try j.fullyDeletedBlobIds() == ["b2"],
                "the phantoms' blob is still not reclaimable — those bytes bill for ever with nothing pointing at them")
    }

    /// A file the user genuinely re-deposited after deleting it was `planned`, not `discovered` — the repair
    /// must not touch it.
    @Test func aGenuinelyReDepositedFileIsNotSweptUpByTheRepair() throws {
        let path = try legacyJournal([
            (id: "back.jpg", path: "back.jpg", status: "planned", blobId: nil),
        ])
        let j = try Journal(path: path)
        #expect(try j.listFiles().map(\.relativePath) == ["back.jpg"])
        #expect(try j.settledFileIds().isEmpty, "a file waiting to upload was marked settled and will never be uploaded")
    }

    /// The migration runs once and is idempotent — re-opening the same journal must not re-do anything.
    @Test func reOpeningAMigratedJournalChangesNothing() throws {
        let path = try legacyJournal([
            (id: "a.jpg", path: "a.jpg", status: "archived", blobId: "b1"),
            (id: "gone.jpg", path: "gone.jpg", status: "deleted", blobId: "b1"),
        ], blobs: [(id: "b1", status: "verified")])

        let before = try Journal(path: path).listFiles().map { "\($0.relativePath):\($0.status)" }
        let after = try Journal(path: path).listFiles().map { "\($0.relativePath):\($0.status)" }
        #expect(before == after)
    }
}
