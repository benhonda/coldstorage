import Testing
import Foundation
import Csqlite3
@testable import ColdStorageCore

/// Opening a journal from before `files.metadata` existed (2026-08-29): its single `createdAt` column held a
/// file's mtime OR a photo's capture date, depending on the source. The migration files it under the name
/// that was true for that row and drops the column — so the date has exactly one home afterwards.
@Suite struct CreatedAtMigrationTests {
    @Test func theOldDateColumnFoldsIntoMetadataUnderItsHonestName() throws {
        let path = FileManager.default.temporaryDirectory
            .appendingPathComponent("cs-legacy-ca-\(UUID().uuidString).sqlite").path
        var handle: OpaquePointer?
        try #require(sqlite3_open_v2(path, &handle, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE, nil) == SQLITE_OK)
        func exec(_ sql: String) { #expect(sqlite3_exec(handle, sql, nil, nil, nil) == SQLITE_OK, "\(sql)") }
        exec("""
            CREATE TABLE files(
              id TEXT PRIMARY KEY, relativePath TEXT NOT NULL, size INTEGER NOT NULL,
              contentHash TEXT NOT NULL, status TEXT NOT NULL, blobId TEXT,
              "offset" INTEGER, length INTEGER, firstFrame INTEGER, plaintextSha256 TEXT, error TEXT,
              createdAt INTEGER, deletedAt INTEGER, lastAttemptAt INTEGER, sourcePath TEXT);
            """)
        exec("INSERT INTO files(id, relativePath, size, contentHash, status, createdAt, sourcePath) VALUES('f', 'a.txt', 1, 'h', 'archived', 1700000000, '/Users/x/a.txt')")
        exec("INSERT INTO files(id, relativePath, size, contentHash, status, createdAt, sourcePath) VALUES('p', 'IMG.heic', 1, 'h', 'archived', 1600000000, 'photos:ABC/L0/001')")
        exec("INSERT INTO files(id, relativePath, size, contentHash, status, createdAt, sourcePath) VALUES('n', 'b.txt', 1, 'h', 'archived', NULL, NULL)")
        sqlite3_close(handle)

        let j = try Journal(path: path)
        let rows = Dictionary(uniqueKeysWithValues: try j.listFiles().map { ($0.id, $0) })
        #expect(rows["f"]?.metadata == FileMetadata(modifiedAt: 1_700_000_000))   // a file's date was its mtime
        #expect(rows["p"]?.metadata == FileMetadata(createdAt: 1_600_000_000))    // a photo's was its capture date
        #expect(rows["n"]?.metadata == nil)                                        // unknown stays unknown
        // The column is gone — nothing can write a second copy of the date again.
        var h2: OpaquePointer?
        try #require(sqlite3_open_v2(path, &h2, SQLITE_OPEN_READONLY, nil) == SQLITE_OK)
        defer { sqlite3_close(h2) }
        var stmt: OpaquePointer?
        try #require(sqlite3_prepare_v2(h2, "PRAGMA table_info(files)", -1, &stmt, nil) == SQLITE_OK)
        defer { sqlite3_finalize(stmt) }
        var cols: [String] = []
        while sqlite3_step(stmt) == SQLITE_ROW { cols.append(String(cString: sqlite3_column_text(stmt, 1))) }
        #expect(!cols.contains("createdAt") && cols.contains("metadata"))
    }
}
