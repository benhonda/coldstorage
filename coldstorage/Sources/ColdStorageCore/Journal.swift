import Foundation
import Csqlite3

// Durable, crash-safe state — SQLite/WAL via the system library directly (no ORM dependency).
// The resumability guarantee AND the metadata-index SPOF (§6.6). "Archived" is written only after
// a blob verifies. Access is serialized (an internal lock; callers are single-actor anyway).

private let SQLITE_TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

public struct PartRow: Sendable {
    public var blobId: String
    public var partNumber: Int
    public var eTag: String
    public var sha256: String
    public var status: PartStatus
    public init(blobId: String, partNumber: Int, eTag: String, sha256: String, status: PartStatus) {
        self.blobId = blobId; self.partNumber = partNumber; self.eTag = eTag
        self.sha256 = sha256; self.status = status
    }
}

/// One logical file as the browser sees it — the journal IS the SSOT for the user's tree (paths/sizes/
/// status), never S3 keys (we batch+encrypt many files into opaque `blobs/<hash>`). No bytes, no thaw:
/// this is a pure metadata read, so the UI browses instantly even though contents are frozen.
public struct FileRow: Sendable {
    public let id: String
    public let relativePath: String
    public let size: Int
    public let status: FileStatus
    public let blobId: String?
    /// Capture/creation date as Unix epoch seconds; nil when unknown (legacy rows, or a source that
    /// carries no date). The daemon renders it to an ISO-8601 string at the IPC boundary.
    public let createdAt: Int?
    public init(id: String, relativePath: String, size: Int, status: FileStatus, blobId: String?, createdAt: Int?) {
        self.id = id; self.relativePath = relativePath; self.size = size
        self.status = status; self.blobId = blobId; self.createdAt = createdAt
    }
}

public final class Journal: @unchecked Sendable {
    private let db: OpaquePointer
    private let lock = NSLock()

    public init(path: String) throws {
        var handle: OpaquePointer?
        let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX
        guard sqlite3_open_v2(path, &handle, flags, nil) == SQLITE_OK, let h = handle else {
            throw ColdStorageError.staging("cannot open journal at \(path)")
        }
        db = h
        try exec("PRAGMA journal_mode=WAL;")
        try exec("PRAGMA busy_timeout=5000;")
        try migrate()
    }

    /// Smart default excludes — the junk a non-technical user never means to upload. Seeded into the
    /// `excludes` table the first time a journal is created (the daemon is the SSOT for these; the UI
    /// fetches them and no longer hardcodes its own copy). Bare names match at any depth; globs use `*`/`?`.
    public static let defaultExcludes = ["node_modules", ".DS_Store", "*.tmp", ".git", "caches"]

    private func migrate() throws {
        // Seed defaults only on a *fresh* journal, so a user who deletes them doesn't get them back. Detect
        // "fresh" by the excludes table's absence *before* the idempotent CREATE re-asserts it.
        let excludesIsNew = try run("SELECT name FROM sqlite_master WHERE type='table' AND name='excludes'").isEmpty
        try exec("""
            CREATE TABLE IF NOT EXISTS files(
              id TEXT PRIMARY KEY, relativePath TEXT NOT NULL, size INTEGER NOT NULL,
              contentHash TEXT NOT NULL, status TEXT NOT NULL, blobId TEXT,
              "offset" INTEGER, length INTEGER, firstFrame INTEGER, plaintextSha256 TEXT, error TEXT,
              createdAt INTEGER);
            CREATE TABLE IF NOT EXISTS blobs(
              id TEXT PRIMARY KEY, s3Key TEXT NOT NULL, uploadId TEXT,
              noncePrefix BLOB, wrappedDEK BLOB, status TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS parts(
              blobId TEXT NOT NULL, partNumber INTEGER NOT NULL, eTag TEXT NOT NULL,
              sha256 TEXT NOT NULL, status TEXT NOT NULL, PRIMARY KEY(blobId, partNumber));
            CREATE TABLE IF NOT EXISTS sources(
              id TEXT PRIMARY KEY, kind TEXT NOT NULL, path TEXT, addedAt INTEGER NOT NULL DEFAULT 0,
              mountPath TEXT NOT NULL DEFAULT '', paused INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS excludes(
              pattern TEXT PRIMARY KEY, addedAt INTEGER NOT NULL DEFAULT 0);
            """)
        if excludesIsNew {
            for p in Self.defaultExcludes {
                try run("INSERT OR IGNORE INTO excludes(pattern) VALUES(?1)", [.text(p)])
            }
        }
        // Idempotent column add for journals created before mountPath existed (CREATE TABLE IF NOT EXISTS
        // won't alter an existing table). New mounts default to '' here; the addSource path supplies a
        // real basename, so only legacy rows stay root-mounted until re-added.
        let sourceCols = try run("PRAGMA table_info(sources)").compactMap { $0["name"] as? String }
        if !sourceCols.contains("mountPath") {
            try exec("ALTER TABLE sources ADD COLUMN mountPath TEXT NOT NULL DEFAULT ''")
        }
        if !sourceCols.contains("paused") {
            try exec("ALTER TABLE sources ADD COLUMN paused INTEGER NOT NULL DEFAULT 0")
        }
        // Idempotent column add for journals created before `createdAt` existed. Nullable (no DEFAULT): a
        // legacy row's true capture date is unknown, so it stays NULL → "—" in the UI rather than a faked
        // value. New/re-scanned rows get the real `IngestItem.createdAt` via `upsert`.
        let fileCols = try run("PRAGMA table_info(files)").compactMap { $0["name"] as? String }
        if !fileCols.contains("createdAt") {
            try exec("ALTER TABLE files ADD COLUMN createdAt INTEGER")
        }
    }

    // MARK: - tiny SQLite layer
    private enum Bind { case text(String), int(Int), blob(Data), null }

    private func exec(_ sql: String) throws {
        var err: UnsafeMutablePointer<CChar>?
        guard sqlite3_exec(db, sql, nil, nil, &err) == SQLITE_OK else {
            let m = err.map { String(cString: $0) } ?? "unknown"; sqlite3_free(err)
            throw ColdStorageError.staging("sqlite exec: \(m)")
        }
    }

    @discardableResult
    private func run(_ sql: String, _ binds: [Bind] = []) throws -> [[String: Any]] {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            throw ColdStorageError.staging("sqlite prepare: \(String(cString: sqlite3_errmsg(db)))")
        }
        defer { sqlite3_finalize(stmt) }
        for (i, b) in binds.enumerated() {
            let idx = Int32(i + 1)
            switch b {
            case .text(let s): sqlite3_bind_text(stmt, idx, s, -1, SQLITE_TRANSIENT)
            case .int(let n):  sqlite3_bind_int64(stmt, idx, Int64(n))
            case .blob(let d): _ = d.withUnsafeBytes { sqlite3_bind_blob(stmt, idx, $0.baseAddress, Int32(d.count), SQLITE_TRANSIENT) }
            case .null:        sqlite3_bind_null(stmt, idx)
            }
        }
        var rows: [[String: Any]] = []
        var rc = sqlite3_step(stmt)
        while rc == SQLITE_ROW {
            var row: [String: Any] = [:]
            for col in 0..<sqlite3_column_count(stmt) {
                let nm = String(cString: sqlite3_column_name(stmt, col))
                switch sqlite3_column_type(stmt, col) {
                case SQLITE_INTEGER: row[nm] = Int(sqlite3_column_int64(stmt, col))
                case SQLITE_TEXT:    if let t = sqlite3_column_text(stmt, col) { row[nm] = String(cString: t) }
                case SQLITE_BLOB:    if let p = sqlite3_column_blob(stmt, col) { row[nm] = Data(bytes: p, count: Int(sqlite3_column_bytes(stmt, col))) }
                default: break  // NULL
                }
            }
            rows.append(row)
            rc = sqlite3_step(stmt)
        }
        // A write (INSERT/UPDATE/DELETE) yields SQLITE_DONE on the first step and never enters the loop; a
        // SELECT ends on SQLITE_DONE after its rows. Anything else (SQLITE_CONSTRAINT, SQLITE_ERROR, …) is a
        // real failure — surface it. The journal is the SPOF: a silently-swallowed write is how a marker (or
        // any row) can vanish without a trace, so we refuse to report success on a step that didn't finish.
        guard rc == SQLITE_DONE else {
            throw ColdStorageError.staging("sqlite step: \(String(cString: sqlite3_errmsg(db)))")
        }
        return rows
    }

    // MARK: - operations
    /// Upsert discovered files; skip ones already archived with the same hash (idempotent re-scan).
    public func upsert(_ items: [IngestItem]) throws {
        lock.lock(); defer { lock.unlock() }
        try exec("BEGIN;")
        for it in items {
            let cur = try run("SELECT status, contentHash FROM files WHERE id=?1", [.text(it.id)])
            if let r = cur.first, (r["status"] as? String) == FileStatus.archived.rawValue,
               (r["contentHash"] as? String) == it.contentHash { continue }
            // `createdAt` is captured here at discovery (the SSOT moment for intrinsic file metadata).
            // `size` is best-effort here — a Photos asset is size 0 until streamed; `markFileArchived`
            // overwrites it with the exact plaintext byte count once the bytes are sealed.
            try run("""
                INSERT INTO files(id, relativePath, size, contentHash, status, createdAt) VALUES(?1,?2,?3,?4,?5,?6)
                ON CONFLICT(id) DO UPDATE SET relativePath=excluded.relativePath, size=excluded.size,
                    contentHash=excluded.contentHash, status=excluded.status, createdAt=excluded.createdAt
                """, [.text(it.id), .text(it.relativePath), .int(it.size), .text(it.contentHash), .text(FileStatus.planned.rawValue),
                      it.createdAt.map { .int(Int($0.timeIntervalSince1970)) } ?? .null])
        }
        try exec("COMMIT;")
    }

    /// Anchor an EMPTY folder so it survives a reload — a path-only marker row (status `folder`, size 0, no
    /// blob). The tree is derived from file paths, so an empty folder otherwise has nothing to imply it and
    /// vanishes when the UI's local state resets. Idempotent: a no-op if any LIVE row already sits at `path`
    /// (a real file there already implies the folder, or the marker already exists) — so we never stack
    /// duplicate markers. The id is a fresh UUID, NOT derived from the path: `movePath` keeps a marker's id
    /// stable while rewriting its `relativePath`, so a path-derived id would outlive its path and collide the
    /// next time the same path is reused (e.g. another "untitled folder" after the first was renamed) — the
    /// `INSERT` would hit the PK and (silently, pre-hardening) drop the marker. The `folder:` prefix is kept
    /// purely so the row is greppable as a marker; the human-readable path lives in `relativePath`.
    public func createFolder(path: String) throws {
        lock.lock(); defer { lock.unlock() }
        // Skip if any LIVE row already sits AT the path (the marker exists) or UNDER it (a real file already
        // implies the folder) — so we never stack a redundant marker. `substr(...,1,len+1)` is the same
        // prefix test movePath/deletePath use (no LIKE-wildcard escaping).
        let exists = try run("""
            SELECT 1 FROM files
            WHERE (relativePath=?1 OR substr(relativePath, 1, length(?1) + 1) = ?2) AND status != ?3 LIMIT 1
            """, [.text(path), .text("\(path)/"), .text(FileStatus.deleted.rawValue)])
        guard exists.isEmpty else { return }
        try run("""
            INSERT INTO files(id, relativePath, size, contentHash, status) VALUES(?1,?2,0,'',?3)
            """, [.text("folder:\(UUID().uuidString)"), .text(path), .text(FileStatus.folder.rawValue)])
    }

    // MARK: - sources registry (SSOT for what we archive; mutated via IPC)
    /// Register a source; idempotent on `id` (re-adding a folder just refreshes it).
    public func addSource(_ s: SourceRow) throws {
        lock.lock(); defer { lock.unlock() }
        try run("""
            INSERT INTO sources(id, kind, path, mountPath, paused) VALUES(?1,?2,?3,?4,?5)
            ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, path=excluded.path, mountPath=excluded.mountPath, paused=excluded.paused
            """, [.text(s.id), .text(s.kind.rawValue), s.path.map(Bind.text) ?? .null, .text(s.mountPath), .int(s.paused ? 1 : 0)])
    }

    public func removeSource(_ id: String) throws {
        lock.lock(); defer { lock.unlock() }
        try run("DELETE FROM sources WHERE id=?1", [.text(id)])
    }

    /// Toggle a source's pause without re-adding it (its scan is skipped while paused). Idempotent; a
    /// no-op if the id isn't registered.
    public func setSourcePaused(_ id: String, _ paused: Bool) throws {
        lock.lock(); defer { lock.unlock() }
        try run("UPDATE sources SET paused=?2 WHERE id=?1", [.text(id), .int(paused ? 1 : 0)])
    }

    public func listSources() throws -> [SourceRow] {
        lock.lock(); defer { lock.unlock() }
        return try run("SELECT id, kind, path, mountPath, paused FROM sources ORDER BY id").map {
            SourceRow(id: $0["id"] as? String ?? "",
                      kind: SourceKind(rawValue: $0["kind"] as? String ?? "") ?? .folder,
                      path: $0["path"] as? String,
                      mountPath: $0["mountPath"] as? String ?? "",
                      paused: ($0["paused"] as? Int ?? 0) != 0)
        }
    }

    // MARK: - excludes registry (gitignore-style patterns; the SSOT the scan filters by)
    /// Register an exclude pattern; idempotent on the pattern text (re-adding is a no-op).
    public func addExclude(_ pattern: String) throws {
        lock.lock(); defer { lock.unlock() }
        try run("INSERT INTO excludes(pattern) VALUES(?1) ON CONFLICT(pattern) DO NOTHING", [.text(pattern)])
    }

    public func removeExclude(_ pattern: String) throws {
        lock.lock(); defer { lock.unlock() }
        try run("DELETE FROM excludes WHERE pattern=?1", [.text(pattern)])
    }

    public func listExcludes() throws -> [String] {
        lock.lock(); defer { lock.unlock() }
        return try run("SELECT pattern FROM excludes ORDER BY pattern").compactMap { $0["pattern"] as? String }
    }

    /// The browsable file tree (design: the journal is the tree SSOT). A pure metadata `SELECT` — no S3,
    /// no thaw. Ordered by path so the client renders a stable tree. Unknown/garbage status defaults to
    /// `.discovered` rather than dropping the row (the file still exists; the UI coarsens status anyway).
    public func listFiles() throws -> [FileRow] {
        lock.lock(); defer { lock.unlock() }
        return try run("SELECT id, relativePath, size, status, blobId, createdAt FROM files WHERE status != 'deleted' ORDER BY relativePath").map {
            FileRow(id: $0["id"] as? String ?? "",
                    relativePath: $0["relativePath"] as? String ?? "",
                    size: $0["size"] as? Int ?? 0,
                    status: FileStatus(rawValue: $0["status"] as? String ?? "") ?? .discovered,
                    blobId: $0["blobId"] as? String,
                    createdAt: $0["createdAt"] as? Int)
        }
    }

    /// Relocate the subtree rooted at `from` to `to` — the journal edit behind a file/folder **move OR
    /// rename** (a rename is just a move whose `to` is a sibling path with a new basename). The tree lives
    /// in the journal, never in S3 keys, so this is a pure `relativePath` rewrite: the stable `id` (the
    /// `upsert` dedup key — changing it would re-upload the file on the next scan) and the encrypted blob
    /// never move, only where the file appears in the browser. Sweeps `from` AND every descendant (`from/…`)
    /// in one statement. No-op when `from == to`; throws on an into-self move (a folder can't move under
    /// itself). All `length`/`substr` run in SQLite so prefix math is consistent regardless of encoding;
    /// the `substr(...,1,length+1)` test (vs `LIKE`) sidesteps wildcard escaping.
    public func movePath(from: String, to: String) throws {
        guard from != to else { return }
        guard !to.hasPrefix("\(from)/") else {
            throw ColdStorageError.staging("cannot move '\(from)' into itself")
        }
        lock.lock(); defer { lock.unlock() }
        // For the exact row, substr(path, length+1) is "" one past the end → maps to `to`; for "from/x" it
        // is "/x" → maps to "to/x". One expression covers the file-rename and the whole-folder sweep.
        try run("""
            UPDATE files SET relativePath = ?1 || substr(relativePath, length(?2) + 1)
            WHERE relativePath = ?2 OR substr(relativePath, 1, length(?2) + 1) = ?3
            """, [.text(to), .text(from), .text("\(from)/")])
    }

    /// Tombstone the subtree rooted at `path` (status → `.deleted`) — the journal edit behind a file/folder
    /// delete. The row and its blob mapping are KEPT, not removed: the encrypted bytes stay in S3 until a
    /// future repack/GC reclaims them (deep storage's 180-day minimum makes eager deletion pointless, and
    /// the kept mapping is how that GC will find them). Tombstoned files drop out of `listFiles` + the file
    /// count. Sweeps `path` and every descendant; already-tombstoned rows are skipped (idempotent).
    public func deletePath(_ path: String) throws {
        lock.lock(); defer { lock.unlock() }
        try run("""
            UPDATE files SET status = ?1
            WHERE (relativePath = ?2 OR substr(relativePath, 1, length(?2) + 1) = ?3) AND status != ?1
            """, [.text(FileStatus.deleted.rawValue), .text(path), .text("\(path)/")])
    }

    public func ensureBlob(_ plan: BlobPlan, noncePrefix: Data, wrappedDEK: Data) throws {
        lock.lock(); defer { lock.unlock() }
        try run("""
            INSERT INTO blobs(id, s3Key, status, noncePrefix, wrappedDEK) VALUES(?1,?2,?3,?4,?5)
            ON CONFLICT(id) DO NOTHING
            """, [.text(plan.id), .text(plan.s3Key), .text(BlobStatus.open.rawValue), .blob(noncePrefix), .blob(wrappedDEK)])
    }

    public func uploadId(of blobId: String) throws -> String? {
        lock.lock(); defer { lock.unlock() }
        return try run("SELECT uploadId FROM blobs WHERE id=?1", [.text(blobId)]).first?["uploadId"] as? String
    }

    /// Stored key material for an existing blob — so a resumed upload re-stages identical ciphertext.
    public func blobCrypto(_ blobId: String) throws -> (noncePrefix: Data, wrappedDEK: Data)? {
        lock.lock(); defer { lock.unlock() }
        guard let r = try run("SELECT noncePrefix, wrappedDEK FROM blobs WHERE id=?1", [.text(blobId)]).first,
              let np = r["noncePrefix"] as? Data, let wd = r["wrappedDEK"] as? Data else { return nil }
        return (np, wd)
    }

    public func isBlobVerified(_ blobId: String) throws -> Bool {
        lock.lock(); defer { lock.unlock() }
        return (try run("SELECT status FROM blobs WHERE id=?1", [.text(blobId)]).first?["status"] as? String) == BlobStatus.verified.rawValue
    }

    /// Is this file row linked to its archived blob (status `archived`)? A verified blob whose files aren't all
    /// `archived` is an ORPHAN — a prior run died between `markBlobVerified` and the `markFileArchived` loop, so
    /// the bytes are in S3 but the tree shows nothing. The engine uses this to re-link instead of skip-and-strand.
    public func isFileArchived(_ id: String) throws -> Bool {
        lock.lock(); defer { lock.unlock() }
        return (try run("SELECT status FROM files WHERE id=?1", [.text(id)]).first?["status"] as? String) == FileStatus.archived.rawValue
    }

    /// Snapshot counts for the daemon status surface.
    public func summary() throws -> (total: Int, archived: Int, blobsVerified: Int) {
        lock.lock(); defer { lock.unlock() }
        func count(_ sql: String) -> Int { (try? run(sql).first?["c"] as? Int) ?? 0 }
        // `folder` markers anchor empty folders — they aren't files, so they don't count toward the total.
        return (count("SELECT count(*) c FROM files WHERE status NOT IN ('deleted','folder')"),
                count("SELECT count(*) c FROM files WHERE status='archived'"),
                count("SELECT count(*) c FROM blobs WHERE status='verified'"))
    }

    public func setUploadId(_ blobId: String, _ uploadId: String) throws {
        lock.lock(); defer { lock.unlock() }
        try run("UPDATE blobs SET uploadId=?1, status=?2 WHERE id=?3",
                [.text(uploadId), .text(BlobStatus.uploading.rawValue), .text(blobId)])
    }

    public func completedParts(_ blobId: String) throws -> [PartRow] {
        lock.lock(); defer { lock.unlock() }
        return try run("SELECT blobId, partNumber, eTag, sha256, status FROM parts WHERE blobId=?1 ORDER BY partNumber",
                       [.text(blobId)]).map {
            PartRow(blobId: $0["blobId"] as? String ?? "",
                    partNumber: $0["partNumber"] as? Int ?? 0,
                    eTag: $0["eTag"] as? String ?? "",
                    sha256: $0["sha256"] as? String ?? "",
                    status: PartStatus(rawValue: $0["status"] as? String ?? "") ?? .uploaded)
        }
    }

    public func recordPart(_ p: PartRow) throws {
        lock.lock(); defer { lock.unlock() }
        try run("""
            INSERT INTO parts(blobId, partNumber, eTag, sha256, status) VALUES(?1,?2,?3,?4,?5)
            ON CONFLICT(blobId, partNumber) DO UPDATE SET eTag=excluded.eTag, sha256=excluded.sha256, status=excluded.status
            """, [.text(p.blobId), .int(p.partNumber), .text(p.eTag), .text(p.sha256), .text(p.status.rawValue)])
    }

    public func markBlobVerified(_ blobId: String) throws {
        lock.lock(); defer { lock.unlock() }
        try run("UPDATE blobs SET status=?1 WHERE id=?2", [.text(BlobStatus.verified.rawValue), .text(blobId)])
    }

    /// `size` is the EXACT plaintext byte count measured while staging — the SSOT for the file's real size.
    /// It overwrites the discovery-time estimate, which is 0 for a Photos asset (unknown until streamed) and
    /// only stat-derived for a local file. `length` is the *ciphertext* span and is unrelated (it's larger:
    /// plaintext + per-frame AEAD tags).
    public func markFileArchived(_ id: String, blobId: String, offset: Int, length: Int, firstFrame: Int, plaintextSha256: String, size: Int) throws {
        lock.lock(); defer { lock.unlock() }
        try run("""
            UPDATE files SET status=?1, blobId=?2, "offset"=?3, length=?4, firstFrame=?5, plaintextSha256=?6, size=?7 WHERE id=?8
            """, [.text(FileStatus.archived.rawValue), .text(blobId), .int(offset), .int(length), .int(firstFrame), .text(plaintextSha256), .int(size), .text(id)])
    }

    /// Mark logical files `failed` (+ record why) — written when their blob fails *permanently*, so the UI's
    /// ⚠ row is journal truth that survives a `listFiles` refresh and a restart, not a UI guess. Transient
    /// failures are left untouched (they retry next pass). A later successful re-archive overwrites this back
    /// to `archived` (self-correcting). No-op on an empty id set.
    public func markFilesFailed(_ ids: [String], error: String) throws {
        guard !ids.isEmpty else { return }
        lock.lock(); defer { lock.unlock() }
        for id in ids {
            try run("UPDATE files SET status=?1, error=?2 WHERE id=?3",
                    [.text(FileStatus.failed.rawValue), .text(error), .text(id)])
        }
    }

    /// Everything restore needs to locate + decrypt a logical file.
    public func fileMapping(_ id: String) throws -> (blobId: String, offset: Int, length: Int, firstFrame: Int, plaintextSha256: String)? {
        lock.lock(); defer { lock.unlock() }
        guard let r = try run("SELECT blobId, \"offset\", length, firstFrame, plaintextSha256 FROM files WHERE id=?1", [.text(id)]).first,
              let b = r["blobId"] as? String, let o = r["offset"] as? Int, let l = r["length"] as? Int,
              let ff = r["firstFrame"] as? Int, let sha = r["plaintextSha256"] as? String else { return nil }
        return (b, o, l, ff, sha)
    }
}
