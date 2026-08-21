import Foundation
import Csqlite3

// Durable, crash-safe state — SQLite/WAL via the system library directly (no ORM dependency).
// The resumability guarantee AND the metadata-index SPOF (§6.6). "Archived" is written only after
// a blob verifies. Access is serialized (an internal lock; callers are single-actor anyway).

private let SQLITE_TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

/// Line to the daemon's stderr (→ `coldstored.err.log`, tailed by `task daemon:mac:logs`). A schema
/// migration that silently rewrites rows is exactly the invisible work this product refuses to do.
private func log(_ message: String) {
    FileHandle.standardError.write(Data("\(message)\n".utf8))
}

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
    /// When the upload path last actually TRIED this file — every outcome, success or fault. `nil` means no
    /// attempt has been made yet, which is the honest reading of a file that was scanned into the journal
    /// while the daemon was idle. The upload twin of `RestoreRow.lastStepAt`, and for the same reason: the
    /// tree renders `planned` as "Uploading", and without a clock that claim has no expiry.
    public let lastAttemptAt: Int?
    /// Why the last attempt failed, or nil. Present on a `failed` file (a permanent fault) AND on one still
    /// queued after a TRANSIENT fault — those keep retrying, so the row stays honest about being in flight
    /// while still naming the snag. Cleared the moment an attempt succeeds.
    public let error: String?
    public init(id: String, relativePath: String, size: Int, status: FileStatus, blobId: String?,
                createdAt: Int?, lastAttemptAt: Int? = nil, error: String? = nil) {
        self.id = id; self.relativePath = relativePath; self.size = size
        self.status = status; self.blobId = blobId; self.createdAt = createdAt
        self.lastAttemptAt = lastAttemptAt; self.error = error
    }
}

/// A blob whose object is TAGGED for lifecycle expiry while a live file still points at it — bytes S3 is
/// scheduled to delete that the journal calls safe. Two ways in: `reapDeleted` dying between the tag and
/// `markBlobReaped`, or a deleted file being revived onto a blob that was already tagged.
///
/// Modelled as an INVARIANT the engine re-checks every run (`Journal.blobsNeedingUntag`) rather than an
/// event handed along from the revive that caused it. Same reason the intent marker exists at all: a
/// one-shot repair that fails has nothing watching it, and the failure mode here is silent data loss.
public struct MistaggedBlob: Sendable {
    public let id: String
    public let s3Key: String
    public init(id: String, s3Key: String) { self.id = id; self.s3Key = s3Key }
}

public final class Journal: @unchecked Sendable {
    private let db: OpaquePointer
    private let lock = NSLock()

    public init(path: String) throws {
        var handle: OpaquePointer?
        let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX
        guard sqlite3_open_v2(path, &handle, flags, nil) == SQLITE_OK, let h = handle else {
            throw ColdStorageError.invalidRequest("cannot open journal at \(path)")
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
              createdAt INTEGER, deletedAt INTEGER, lastAttemptAt INTEGER);
            CREATE TABLE IF NOT EXISTS blobs(
              id TEXT PRIMARY KEY, s3Key TEXT NOT NULL, uploadId TEXT,
              noncePrefix BLOB, wrappedDEK BLOB, status TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS parts(
              blobId TEXT NOT NULL, partNumber INTEGER NOT NULL, eTag TEXT NOT NULL,
              sha256 TEXT NOT NULL, status TEXT NOT NULL, PRIMARY KEY(blobId, partNumber));
            -- Blob membership, recorded at `ensureBlob` (blob creation) rather than inferred later from
            -- `files.blobId`. `files.blobId` is only written once a file is ARCHIVED, so it cannot describe a
            -- blob that is mid-flight or verified-but-unlinked — which is exactly the state a repair pass has
            -- to reason about. Durable membership is what lets the planner stop re-deriving it from a full
            -- re-scan (see `UploadEngine.run`); without it, planning is the only place a blob's members exist.
            CREATE TABLE IF NOT EXISTS blob_members(
              blobId TEXT NOT NULL, fileId TEXT NOT NULL, ordinal INTEGER NOT NULL DEFAULT 0,
              PRIMARY KEY(blobId, fileId));
            CREATE TABLE IF NOT EXISTS sources(
              id TEXT PRIMARY KEY, kind TEXT NOT NULL, path TEXT, addedAt INTEGER NOT NULL DEFAULT 0,
              mountPath TEXT NOT NULL DEFAULT '', paused INTEGER NOT NULL DEFAULT 0,
              lastScanAt INTEGER, error TEXT);
            CREATE TABLE IF NOT EXISTS excludes(
              pattern TEXT PRIMARY KEY, addedAt INTEGER NOT NULL DEFAULT 0);
            -- Requested transfers (getting a copy back onto this Mac). Journal-backed, not app-held, for
            -- three reasons that were each a real bug: an app-held transfer vanished on sign-out, vanished
            -- on restart, and could never progress while the app was closed — though the request modal
            -- promises it will. The daemon's run loop drives these forward (see `restorePass`).
            CREATE TABLE IF NOT EXISTS restores(
              id TEXT PRIMARY KEY, fileId TEXT NOT NULL, out TEXT NOT NULL, jobId TEXT,
              state TEXT NOT NULL, tier TEXT NOT NULL, bytes INTEGER NOT NULL DEFAULT 0,
              requestedAt INTEGER NOT NULL, readyAt INTEGER, lastStepAt INTEGER,
              completedAt INTEGER, error TEXT);
            CREATE INDEX IF NOT EXISTS restores_state ON restores(state);
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
        // Per-source scan outcome. Before these, a run failure was an ephemeral `error` bus event and
        // nothing else — so a watched folder that had stopped backing up was listed in Settings exactly like
        // one that was working, and if the app wasn't open when it broke there was no trace at all. Nullable,
        // not backfilled: a folder we have never scanned since this shipped has no honest scan time.
        if !sourceCols.contains("lastScanAt") {
            try exec("ALTER TABLE sources ADD COLUMN lastScanAt INTEGER")
        }
        if !sourceCols.contains("error") {
            try exec("ALTER TABLE sources ADD COLUMN error TEXT")
        }
        // Idempotent column add for journals created before `createdAt` existed. Nullable (no DEFAULT): a
        // legacy row's true capture date is unknown, so it stays NULL → "—" in the UI rather than a faked
        // value. New/re-scanned rows get the real `IngestItem.createdAt` via `upsert`.
        let fileCols = try run("PRAGMA table_info(files)").compactMap { $0["name"] as? String }
        if !fileCols.contains("createdAt") {
            try exec("ALTER TABLE files ADD COLUMN createdAt INTEGER")
        }
        // The upload half of the freshness clock `restores.lastStepAt` is for a download. Nullable and NOT
        // backfilled, for the same reason: a legacy row has no record of when the upload path last tried it,
        // and "planned" alone cannot tell a queued file apart from an abandoned one.
        if !fileCols.contains("lastAttemptAt") {
            try exec("ALTER TABLE files ADD COLUMN lastAttemptAt INTEGER")
        }
        // Deletion as its OWN column, so tombstoning stops destroying the row's kind + lifecycle. Not a bare
        // column add — it carries existing tombstones over and repairs what the old scheme corrupted.
        if !fileCols.contains("deletedAt") {
            try migrateDeletionOffStatus()
        }
        let memberCols = try run("PRAGMA table_info(blob_members)").compactMap { $0["name"] as? String }
        if !memberCols.contains("ordinal") {
            try exec("ALTER TABLE blob_members ADD COLUMN ordinal INTEGER NOT NULL DEFAULT 0")
        }
        // `archivedAt`: when a blob's object landed in S3 — the clock Deep Archive's 180-day minimum runs on,
        // and therefore the clock the user's space comes back on. Nullable: a legacy blob's upload time is
        // unknown, and `reclaimedCreditBytes` treats unknown as "not yet eligible" rather than guessing in
        // the direction that would hand out space we're still paying for.
        let blobCols = try run("PRAGMA table_info(blobs)").compactMap { $0["name"] as? String }
        if !blobCols.contains("archivedAt") {
            try exec("ALTER TABLE blobs ADD COLUMN archivedAt INTEGER")
        }
        // `reapTaggedAt`: when we asked S3 to tag this object for lifecycle expiry — written BEFORE the tag
        // call, as an intent marker, so "tagged" is never something only S3 knows. `reapDeleted` crashing
        // between the tag and `markBlobReaped` used to leave a `verified` blob whose object was quietly
        // scheduled for deletion, with nothing anywhere able to tell. That state is now legible as
        // `verified AND reapTaggedAt IS NOT NULL`, and `reviveFiles` hands it back for untagging.
        if !blobCols.contains("reapTaggedAt") {
            try exec("ALTER TABLE blobs ADD COLUMN reapTaggedAt INTEGER")
        }
        // Idempotent column add for journals created before `lastStepAt` existed. Nullable, and deliberately
        // NOT backfilled from `requestedAt`: a legacy row genuinely has no record of when it was last
        // checked, and inventing one would hand the app a freshness it can't vouch for — the exact lie the
        // column exists to stop. NULL reads as "never checked", which for a row that has sat pending since
        // before this shipped is the truth.
        let restoreCols = try run("PRAGMA table_info(restores)").compactMap { $0["name"] as? String }
        if !restoreCols.contains("lastStepAt") {
            try exec("ALTER TABLE restores ADD COLUMN lastStepAt INTEGER")
        }
    }

    /// Move deletion out of `files.status` and into `files.deletedAt`, and repair the rows the old scheme
    /// corrupted. One-shot: gated on the column's absence, and every statement is idempotent anyway.
    ///
    /// **Why the old scheme had to go.** `status` encoded three independent things at once — the row's KIND
    /// (`folder` marker vs file), its upload LIFECYCLE, and whether it was DELETED. Tombstoning overwrote the
    /// first two to record the third, so the pre-delete state was simply gone. Un-tombstoning had nothing to
    /// restore *to* and guessed `discovered` for the whole subtree, which produced two user-visible bugs:
    /// a folder marker came back as a phantom FILE named after the folder, and every file that had ever been
    /// in a re-deposited folder came back whether or not it was re-dropped. Neither can ever be planned
    /// (nothing on disk feeds them), and `discovered` renders as "uploading", so they sat there for ever.
    ///
    /// **The backfill.** A tombstone's original status is unrecoverable, so it is inferred from evidence that
    /// survived: the `folder:` id prefix marks a marker, and a non-null `blobId` marks a file that reached
    /// `archived` (`deletePath` never cleared it — only the old revive did). Anything else is `planned`,
    /// which costs at most one re-upload if it is ever revived, and never loses bytes.
    ///
    /// **The repair.** `discovered` was only ever written by the old revive (nothing else in the codebase
    /// writes it — it is otherwise just `listFiles`' decode fallback), so every persisted `discovered` row is
    /// a phantom from that bug. They are re-tombstoned, which is what the user asked for when they deleted
    /// them, and re-linked to their blob where it is still verified so those bytes become reclaimable again —
    /// the old revive nulled `blobId`, which is what stopped `fullyDeletedBlobIds` from ever seeing them.
    /// Files the user genuinely re-deposited are untouched: `upsert` moved those to `planned` immediately.
    private func migrateDeletionOffStatus() throws {
        try exec("ALTER TABLE files ADD COLUMN deletedAt INTEGER")
        let now = Int(Date().timeIntervalSince1970)
        // Both passes recover a status the same way, so the recovery lives in one place.
        let recoveredStatus = """
            CASE WHEN id LIKE 'folder:%' THEN '\(FileStatus.folder.rawValue)'
                 WHEN blobId IS NOT NULL THEN '\(FileStatus.archived.rawValue)'
                 ELSE '\(FileStatus.planned.rawValue)' END
            """
        try transaction {
            let tombstones = try run("SELECT count(*) c FROM files WHERE status = 'deleted'")
                .first?["c"] as? Int ?? 0
            try run("UPDATE files SET deletedAt = ?1, status = \(recoveredStatus) WHERE status = 'deleted'",
                    [.int(now)])
            // Phantoms: re-link first (the re-linked `blobId` is what `recoveredStatus` reads), then
            // re-tombstone. Only a still-`verified` blob may be re-linked — a reaped one's bytes are on their
            // way out, and pointing a row at them would be a lie about where the file is.
            let phantoms = try run("SELECT count(*) c FROM files WHERE status = ?1",
                                   [.text(FileStatus.discovered.rawValue)]).first?["c"] as? Int ?? 0
            try run("""
                UPDATE files SET blobId = (
                    SELECT m.blobId FROM blob_members m JOIN blobs b ON b.id = m.blobId
                     WHERE m.fileId = files.id AND b.status = ?2 LIMIT 1)
                 WHERE status = ?1 AND blobId IS NULL
                """, [.text(FileStatus.discovered.rawValue), .text(BlobStatus.verified.rawValue)])
            try run("UPDATE files SET deletedAt = ?2, status = \(recoveredStatus) WHERE status = ?1",
                    [.text(FileStatus.discovered.rawValue), .int(now)])
            log("Journal: migrated deletion off `status` — \(tombstones) tombstone(s) carried over, "
                + "\(phantoms) phantom row(s) from the folder-revive bug re-deleted")
        }
    }

    // MARK: - tiny SQLite layer
    private enum Bind { case text(String), int(Int), blob(Data), null }

    private func exec(_ sql: String) throws {
        var err: UnsafeMutablePointer<CChar>?
        guard sqlite3_exec(db, sql, nil, nil, &err) == SQLITE_OK else {
            let m = err.map { String(cString: $0) } ?? "unknown"; sqlite3_free(err)
            throw ColdStorageError.invalidRequest("sqlite exec: \(m)")
        }
    }

    /// Run `body` inside a SQLite transaction, rolling back if it throws.
    ///
    /// The rollback is the entire point. `run` throws on any non-`SQLITE_DONE` step, and `try` propagates
    /// straight past a trailing `COMMIT` — so a hand-rolled BEGIN/COMMIT pair leaves the transaction OPEN on
    /// this shared connection. Every later write then silently joins that uncommitted transaction (and the
    /// next `BEGIN` fails with "cannot start a transaction within a transaction"), appearing to succeed and
    /// vanishing when the daemon exits. That is exactly the silent data loss this journal exists to refuse.
    ///
    /// Caller holds `lock`; this does not take it.
    private func transaction<T>(_ body: () throws -> T) throws -> T {
        try exec("BEGIN;")
        do {
            let result = try body()
            try exec("COMMIT;")
            return result
        } catch {
            try? exec("ROLLBACK;")   // best-effort: the original error is what the caller needs to see
            throw error
        }
    }

    @discardableResult
    private func run(_ sql: String, _ binds: [Bind] = []) throws -> [[String: Any]] {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            throw ColdStorageError.invalidRequest("sqlite prepare: \(String(cString: sqlite3_errmsg(db)))")
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
            throw ColdStorageError.invalidRequest("sqlite step: \(String(cString: sqlite3_errmsg(db)))")
        }
        return rows
    }

    // MARK: - operations
    /// Upsert discovered files; skip ones already archived with the same hash (idempotent re-scan).
    ///
    /// `reviving` says whether this scan is the user EXPLICITLY asking for these items — a drag-drop deposit
    /// or a photo pick — as opposed to a watched folder's periodic re-scan. Only an explicit ask may bring a
    /// tombstoned file back (see `reviveFiles`); a re-scan must never, or deleting anything inside a watched
    /// folder would be undone by the next poll. Scoping the revive to `items` is what stops a re-deposited
    /// folder resurrecting every file that was *ever* in it.
    public func upsert(_ items: [IngestItem], reviving: Bool = false) throws {
        lock.lock(); defer { lock.unlock() }
        try transaction {
        if reviving { try reviveFilesLocked(ids: items.map(\.id)) }
        for it in items {
            let cur = try run("SELECT status, contentHash, deletedAt FROM files WHERE id=?1", [.text(it.id)])
            // **A deletion outranks a rescan.** Depositing a file doesn't remove it from disk, so a watched
            // folder keeps finding it forever. Letting discovery overwrite a tombstone made deleting
            // meaningless — the file returned within the poll interval, was re-uploaded, and its old blob
            // stopped counting as fully-deleted, so nothing was ever reclaimed either. The user's explicit
            // "remove this" beats the scanner's "I can still see it". Anything still tombstoned here was not
            // in an explicit deposit (`reviveFiles` above cleared those), so it stays deleted. Checked FIRST,
            // so the archived short-circuit below is only ever asked about live rows.
            if let r = cur.first, r["deletedAt"] != nil { continue }
            if let r = cur.first, (r["status"] as? String) == FileStatus.archived.rawValue,
               (r["contentHash"] as? String) == it.content.planKey { continue }
            // `createdAt` is captured here at discovery (the SSOT moment for intrinsic file metadata).
            // `size` is best-effort here — a Photos asset is size 0 until streamed; `markFileArchived`
            // overwrites it with the exact plaintext byte count once the bytes are sealed.
            try run("""
                INSERT INTO files(id, relativePath, size, contentHash, status, createdAt) VALUES(?1,?2,?3,?4,?5,?6)
                ON CONFLICT(id) DO UPDATE SET relativePath=excluded.relativePath, size=excluded.size,
                    contentHash=excluded.contentHash, status=excluded.status, createdAt=excluded.createdAt
                """, [.text(it.id), .text(it.relativePath), .int(it.size), .text(it.content.planKey), .text(FileStatus.planned.rawValue),
                      it.createdAt.map { .int(Int($0.timeIntervalSince1970)) } ?? .null])
        }
        }
    }

    /// Bring tombstoned rows back — the deliberate counterpart to `deletePath`, and the ONLY way a deleted
    /// file returns. Scoped to the ids the user explicitly re-deposited, never to a path prefix: re-dropping
    /// a folder used to un-delete its whole former subtree, so files that were no longer on disk came back as
    /// rows nothing could ever upload.
    ///
    /// Clearing `deletedAt` restores the row exactly as it was, which for a file whose blob is still
    /// `verified` means it stays `archived` — correct, because those bytes never left S3, and honest, because
    /// the tree says "stored" instead of miming an upload that isn't happening. If the blob is gone (reaped,
    /// or never there) the row drops to `planned` with its stale link cleared, so the next pass re-uploads it.
    /// A file whose CONTENT changed since it was archived is handled downstream by `upsert`'s hash check.
    ///
    /// Reviving onto a blob that was tagged for expiry is NOT handled here: that's an invariant
    /// (`blobsNeedingUntag`) the engine re-checks every run, so it self-heals instead of depending on this
    /// call's caller to notice.
    /// Internal, not public: the ONLY production caller is `upsert(reviving:)`, which scopes it to the items
    /// a deposit actually enumerated. Exposing an un-scoped revive is how the path-prefix version got called
    /// with a folder name in the first place.
    func reviveFiles(ids: [String]) throws {
        lock.lock(); defer { lock.unlock() }
        try transaction { try reviveFilesLocked(ids: ids) }
    }

    /// Caller holds `lock` and is inside a transaction.
    private func reviveFilesLocked(ids: [String]) throws {
        var kept = 0, replanned = 0
        for id in ids {
            guard let r = try run("SELECT status, blobId, deletedAt FROM files WHERE id=?1", [.text(id)]).first,
                  r["deletedAt"] != nil else { continue }
            let blob = try (r["blobId"] as? String).flatMap {
                try run("SELECT status FROM blobs WHERE id=?1", [.text($0)]).first
            }
            // A folder marker holds no bytes, so "are its bytes still there?" doesn't apply to it — it just
            // comes back as the marker it was. Re-planning one turned it into a phantom FILE named after the
            // folder, which is the bug this whole path exists to not repeat.
            let isMarker = (r["status"] as? String) == FileStatus.folder.rawValue
            let bytesStillThere = (blob?["status"] as? String) == BlobStatus.verified.rawValue
            if isMarker || bytesStillThere {
                try run("UPDATE files SET deletedAt=NULL WHERE id=?1", [.text(id)])
                kept += 1
            } else {
                try run("UPDATE files SET deletedAt=NULL, status=?2, blobId=NULL WHERE id=?1",
                        [.text(id), .text(FileStatus.planned.rawValue)])
                replanned += 1
            }
        }
        // A revive that keeps its bytes uploads NOTHING, so it leaves no trace in the run's "N new item(s)"
        // line — the deposit looks like it did nothing at all. Say what came back and how, or the fastest
        // path in the product is also the only one with no record of having happened.
        if kept + replanned > 0 {
            log("Journal: revived \(kept + replanned) deleted file(s) — \(kept) re-linked to bytes still in "
                + "S3, \(replanned) queued for re-upload")
        }
    }

    /// **Bytes S3 is scheduled to delete that a live file still points at.** A `verified` blob carrying a
    /// reap-tag intent while at least one of its members is un-deleted — see `MistaggedBlob` for the two ways
    /// in. The engine re-checks this every run and clears the tag (then `clearReapTag`), so a reclaim that
    /// died halfway, or a revive onto an already-tagged blob, heals itself rather than waiting for the
    /// lifecycle sweep to take the bytes.
    ///
    /// `reaped` blobs are deliberately excluded: their members were ALL deleted, so a revived one is
    /// re-planned onto fresh bytes (`reviveFiles`) and the old object is genuinely dead. Un-tagging it would
    /// resurrect garbage nothing references — and that the user has already been credited for.
    public func blobsNeedingUntag() throws -> [MistaggedBlob] {
        lock.lock(); defer { lock.unlock() }
        return try run("""
            SELECT DISTINCT b.id, b.s3Key FROM blobs b
              JOIN blob_members m ON m.blobId = b.id
              JOIN files f ON f.id = m.fileId
             WHERE b.status = ?1 AND b.reapTaggedAt IS NOT NULL AND f.deletedAt IS NULL
            """, [.text(BlobStatus.verified.rawValue)]).compactMap {
            guard let id = $0["id"] as? String, let key = $0["s3Key"] as? String else { return nil }
            return MistaggedBlob(id: id, s3Key: key)
        }
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
            WHERE (relativePath=?1 OR substr(relativePath, 1, length(?1) + 1) = ?2) AND deletedAt IS NULL LIMIT 1
            """, [.text(path), .text("\(path)/")])
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
        return try run("SELECT id, kind, path, mountPath, paused, lastScanAt, error FROM sources ORDER BY id").map {
            SourceRow(id: $0["id"] as? String ?? "",
                      kind: SourceKind(rawValue: $0["kind"] as? String ?? "") ?? .folder,
                      path: $0["path"] as? String,
                      mountPath: $0["mountPath"] as? String ?? "",
                      paused: ($0["paused"] as? Int ?? 0) != 0,
                      lastScanAt: $0["lastScanAt"] as? Int,
                      error: $0["error"] as? String)
        }
    }

    /// Record what happened the last time this source was scanned — `nil` error means it worked.
    ///
    /// Called once per source per pass, on every outcome (`ScanReportingSource` → `currentSource`). The
    /// third instance of the same fix as `stampRestoreStep` and `recordFileFault`, and the one with the most
    /// at stake: a watched folder is the promise that files are being backed up, and until this existed a
    /// folder that had silently stopped was listed exactly like a working one.
    ///
    /// Clears `error` on success for the reason every sibling does — a recorded fault is history the moment
    /// the thing works, and a stale "couldn't read your drive" on a folder that's been fine since Tuesday is
    /// its own kind of lie.
    public func markSourceScanned(_ id: String, error: String?) throws {
        lock.lock(); defer { lock.unlock() }
        try run("""
            UPDATE sources SET lastScanAt=CAST(strftime('%s','now') AS INTEGER), error=?2 WHERE id=?1
            """, [.text(id), error.map(Bind.text) ?? .null])
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

    // MARK: - restores registry (requested transfers; the SSOT behind the app's Transfers page)

    private func restoreRow(_ r: [String: Any]) -> RestoreRow {
        RestoreRow(id: r["id"] as? String ?? "",
                   fileId: r["fileId"] as? String ?? "",
                   out: r["out"] as? String ?? "",
                   jobId: r["jobId"] as? String,
                   // Unknown/garbage state defaults to `failed`, not `pending`: a row we can't read must not
                   // masquerade as live work the run loop will keep poking at forever.
                   state: RestoreState(rawValue: r["state"] as? String ?? "") ?? .failed,
                   tier: RestoreTier(rawValue: r["tier"] as? String ?? "") ?? .bulk,
                   bytes: r["bytes"] as? Int ?? 0,
                   requestedAt: r["requestedAt"] as? Int ?? 0,
                   readyAt: r["readyAt"] as? Int,
                   lastStepAt: r["lastStepAt"] as? Int,
                   completedAt: r["completedAt"] as? Int,
                   error: r["error"] as? String)
    }

    /// Record a newly requested transfer. The app calls this the moment a restore is authorized (paid, or
    /// free under the allowance), so the transfer is durable BEFORE any thaw is polled — a crash between
    /// paying and recording would otherwise lose a transfer the user was charged for.
    public func addRestore(_ r: RestoreRow) throws {
        lock.lock(); defer { lock.unlock() }
        try run("""
            INSERT INTO restores(id, fileId, out, jobId, state, tier, bytes, requestedAt, readyAt, lastStepAt, completedAt, error)
            VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
            """, [.text(r.id), .text(r.fileId), .text(r.out), r.jobId.map(Bind.text) ?? .null,
                  .text(r.state.rawValue), .text(r.tier.rawValue), .int(r.bytes), .int(r.requestedAt),
                  r.readyAt.map(Bind.int) ?? .null, r.lastStepAt.map(Bind.int) ?? .null,
                  r.completedAt.map(Bind.int) ?? .null, r.error.map(Bind.text) ?? .null])
    }

    /// Newest first — the order the Transfers page renders in (Active on top, then history).
    public func listRestores() throws -> [RestoreRow] {
        lock.lock(); defer { lock.unlock() }
        return try run("""
            SELECT id, fileId, out, jobId, state, tier, bytes, requestedAt, readyAt, lastStepAt, completedAt, error
            FROM restores ORDER BY requestedAt DESC, id DESC
            """).map(restoreRow)
    }

    public func restore(id: String) throws -> RestoreRow? {
        lock.lock(); defer { lock.unlock() }
        return try run("""
            SELECT id, fileId, out, jobId, state, tier, bytes, requestedAt, readyAt, lastStepAt, completedAt, error
            FROM restores WHERE id=?1
            """, [.text(id)]).first.map(restoreRow)
    }

    /// The in-flight states, as SQL placeholders + binds starting at `from`. Derived from
    /// `RestoreState.isActive` rather than spelled out, so "what counts as in flight" has one definition
    /// (PILLAR3) and adding a state can't leave a query behind.
    private func activeStateHoles(from: Int) -> (sql: String, binds: [Bind]) {
        let states = RestoreState.allCases.filter(\.isActive).map(\.rawValue)
        let sql = states.indices.map { "?\($0 + from)" }.joined(separator: ",")
        return (sql, states.map(Bind.text))
    }

    /// The transfers the run loop should push forward this pass — everything still working. Ordered oldest
    /// first so the longest-waiting transfer is served first.
    public func activeRestores() throws -> [RestoreRow] {
        lock.lock(); defer { lock.unlock() }
        let active = activeStateHoles(from: 1)
        return try run("""
            SELECT id, fileId, out, jobId, state, tier, bytes, requestedAt, readyAt, lastStepAt, completedAt, error
            FROM restores WHERE state IN (\(active.sql)) ORDER BY requestedAt ASC, id ASC
            """, active.binds).map(restoreRow)
    }

    /// Advance one transfer after a step SUCCEEDED. `readyAt`/`completedAt` are only ever set, never
    /// cleared by a `nil` argument — `nil` means "leave it alone", so a `pending → transferring` step can't
    /// erase the `readyAt` a free resume is decided from.
    ///
    /// `error` is the opposite: it is CLEARED, because the step just worked. A recorded fault is history
    /// the moment the thing succeeds, and leaving it behind would pin a stale "we hit a snag" note on a
    /// transfer that has since recovered — the same class of lie this whole feature exists to stop telling.
    /// Recording a fault is a separate method on purpose: two intents, two names, no tri-state flag.
    ///
    /// **Only moves a transfer that is still IN FLIGHT** (`WHERE state IN (active)`), and that guard is the
    /// point rather than a nicety. `restorePass` snapshots its work list and then awaits S3 for each row, so
    /// a Stop can land mid-pass; without this the pass would resume and write its stale conclusion over the
    /// top, quietly un-cancelling a transfer the user had stopped. Making it structural means no future
    /// caller has to remember. Deliberate revivals go through `reopenRestore`, which is exempt.
    public func setRestoreState(_ id: String, _ state: RestoreState,
                                readyAt: Int? = nil, completedAt: Int? = nil) throws {
        lock.lock(); defer { lock.unlock() }
        let active = activeStateHoles(from: 5)
        try run("""
            UPDATE restores SET state=?2,
              readyAt=COALESCE(?3, readyAt), completedAt=COALESCE(?4, completedAt), error=NULL
            WHERE id=?1 AND state IN (\(active.sql))
            """, [.text(id), .text(state.rawValue), readyAt.map(Bind.int) ?? .null,
                  completedAt.map(Bind.int) ?? .null] + active.binds)
    }

    /// Stamp that the run loop just tried to move this transfer — the freshness half of `RestoreRow`.
    ///
    /// Called once per active row per pass, on EVERY outcome including a thrown one, because the question it
    /// answers is "did anything look at this recently?", not "did it go well". `error` answers the second.
    /// Separating them is what lets the page tell a healthy 48-hour wait apart from a transfer nothing has
    /// touched in a month, which it previously could not do at all.
    ///
    /// Touches only `lastStepAt`, so it can never disturb state, `readyAt` or a fault recorded by the same
    /// pass — and it carries no in-flight guard for the same reason: recording that we looked at a row is
    /// true regardless of what the row became while we looked, and it cannot reanimate anything.
    public func stampRestoreStep(_ id: String, at: Int) throws {
        lock.lock(); defer { lock.unlock() }
        try run("UPDATE restores SET lastStepAt=?2 WHERE id=?1", [.text(id), .int(at)])
    }

    /// Record why a step failed. `state` is the caller's classification: a permanent fault lands `.failed`,
    /// a transient one stays where it was so the run loop retries it next pass (see `restorePass`). Either
    /// way the reason is stored ON the transfer, so the page can name what went wrong rather than showing a
    /// bare toast detached from any row.
    ///
    /// Same in-flight guard as `setRestoreState`, for the same reason: a fault from a pass that was already
    /// running must not reanimate a transfer the user stopped while it ran.
    public func recordRestoreFault(_ id: String, _ state: RestoreState, error: String) throws {
        lock.lock(); defer { lock.unlock() }
        let active = activeStateHoles(from: 4)
        try run("UPDATE restores SET state=?2, error=?3 WHERE id=?1 AND state IN (\(active.sql))",
                [.text(id), .text(state.rawValue), .text(error)] + active.binds)
    }

    /// Put a stopped/failed transfer back to work: clear the stale error so the row doesn't carry the last
    /// failure forward as if it were current. `readyAt` deliberately SURVIVES — the blob is still warm, and
    /// that fact is exactly what makes this resume free (see `RestoreRow.isResumable`).
    public func reopenRestore(_ id: String, _ state: RestoreState) throws {
        lock.lock(); defer { lock.unlock() }
        try run("UPDATE restores SET state=?2, error=NULL, completedAt=NULL WHERE id=?1",
                [.text(id), .text(state.rawValue)])
    }

    /// Drop a transfer from the history list. The bytes it already wrote are the user's file and stay put —
    /// this forgets the RECORD, not the copy on disk.
    public func deleteRestore(_ id: String) throws {
        lock.lock(); defer { lock.unlock() }
        try run("DELETE FROM restores WHERE id=?1", [.text(id)])
    }

    /// The set of vault-relative paths currently occupied by a LIVE row (file OR folder marker; tombstoned
    /// rows excluded). The SSOT for deposit collision detection — a dropped item collides iff its target
    /// `relativePath` is in this set — and the "taken" set the `keepBoth` uniquifier avoids. One read; the
    /// caller probes membership in-memory (the vault tree is personal-scale, so a full snapshot beats N
    /// per-path queries).
    public func livePaths() throws -> Set<String> {
        lock.lock(); defer { lock.unlock() }
        return Set(try run("SELECT relativePath FROM files WHERE deletedAt IS NULL")
            .compactMap { $0["relativePath"] as? String })
    }

    /// The browsable file tree (design: the journal is the tree SSOT). A pure metadata `SELECT` — no S3,
    /// no thaw. Ordered by path so the client renders a stable tree. Unknown/garbage status defaults to
    /// `.discovered` rather than dropping the row (the file still exists; the UI coarsens status anyway).
    public func listFiles() throws -> [FileRow] {
        lock.lock(); defer { lock.unlock() }
        return try run("SELECT id, relativePath, size, status, blobId, createdAt, lastAttemptAt, error FROM files WHERE deletedAt IS NULL ORDER BY relativePath").map {
            FileRow(id: $0["id"] as? String ?? "",
                    relativePath: $0["relativePath"] as? String ?? "",
                    size: $0["size"] as? Int ?? 0,
                    status: FileStatus(rawValue: $0["status"] as? String ?? "") ?? .discovered,
                    blobId: $0["blobId"] as? String,
                    createdAt: $0["createdAt"] as? Int,
                    lastAttemptAt: $0["lastAttemptAt"] as? Int,
                    error: $0["error"] as? String)
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
            throw ColdStorageError.invalidRequest("cannot move '\(from)' into itself")
        }
        lock.lock(); defer { lock.unlock() }
        // For the exact row, substr(path, length+1) is "" one past the end → maps to `to`; for "from/x" it
        // is "/x" → maps to "to/x". One expression covers the file-rename and the whole-folder sweep.
        try run("""
            UPDATE files SET relativePath = ?1 || substr(relativePath, length(?2) + 1)
            WHERE relativePath = ?2 OR substr(relativePath, 1, length(?2) + 1) = ?3
            """, [.text(to), .text(from), .text("\(from)/")])
    }

    /// Tombstone the subtree rooted at `path` (`deletedAt` → now) — the journal edit behind a file/folder
    /// delete. The row and its blob mapping are KEPT, not removed: the encrypted bytes stay in S3 until every file sharing
    /// their blob is deleted too, at which point `UploadEngine.reapDeleted` tags the object for lifecycle
    /// expiry (deep storage's 180-day minimum makes eager deletion pointless, and the kept mapping is how
    /// `fullyDeletedBlobIds` finds them). Tombstoned files drop out of `listFiles` + the file
    /// count. Sweeps `path` and every descendant; already-tombstoned rows keep their original `deletedAt`
    /// (idempotent, and the timestamp stays the moment the user actually deleted it).
    ///
    /// `status` is deliberately untouched — see `FileStatus`. It records where the file got to in the upload
    /// lifecycle, which stays true of a deleted file and is exactly what `reviveFiles` needs if it comes back.
    public func deletePath(_ path: String) throws {
        lock.lock(); defer { lock.unlock() }
        try run("""
            UPDATE files SET deletedAt = ?1
            WHERE (relativePath = ?2 OR substr(relativePath, 1, length(?2) + 1) = ?3) AND deletedAt IS NULL
            """, [.int(Int(Date().timeIntervalSince1970)), .text(path), .text("\(path)/")])
    }

    /// Create the blob row **and record its membership**, in one transaction. Membership is written here —
    /// before a byte ships — because that is the only moment it is known for certain; `files.blobId` lags it
    /// by the whole upload, and a blob that dies in between would otherwise have no recoverable member list.
    public func ensureBlob(_ plan: BlobPlan, noncePrefix: Data, wrappedDEK: Data) throws {
        lock.lock(); defer { lock.unlock() }
        try transaction {
            try run("""
                INSERT INTO blobs(id, s3Key, status, noncePrefix, wrappedDEK) VALUES(?1,?2,?3,?4,?5)
                ON CONFLICT(id) DO NOTHING
                """, [.text(plan.id), .text(plan.s3Key), .text(BlobStatus.open.rawValue), .blob(noncePrefix), .blob(wrappedDEK)])
            // `ordinal` pins the SEAL ORDER. Spans are positional, and the repair pass used to re-derive
            // order with `newestFirst` — which sorts on `isFavorite`, a flag the user can toggle in Photos at
            // any time. Toggle it between the original seal and a repair and the members re-order, so
            // recomputed offsets point into the wrong place in ciphertext that is already in S3. The repair
            // path skips verify, so nothing would catch it; it surfaces at restore, as garbage.
            for (i, item) in plan.items.enumerated() {
                try run("INSERT INTO blob_members(blobId, fileId, ordinal) VALUES(?1,?2,?3) ON CONFLICT DO NOTHING",
                        [.text(plan.id), .text(item.id), .int(i)])
            }
        }
    }

    /// The file ids a blob was planned to hold — journal truth, independent of how far the upload got.
    public func blobMembers(_ blobId: String) throws -> [String] {
        lock.lock(); defer { lock.unlock() }
        // ORDER BY ordinal — the order the blob was SEALED in, which is what its byte offsets were measured
        // against. Never re-derive this by sorting the items again (see `ensureBlob`).
        return try run("SELECT fileId FROM blob_members WHERE blobId=?1 ORDER BY ordinal", [.text(blobId)])
            .compactMap { $0["fileId"] as? String }
    }

    /// Verified blobs holding at least one file that never got linked into the tree — the ORPHAN set. The
    /// bytes are in S3 and safe; the tree just doesn't show them. `UploadEngine.run` repairs these from
    /// journal state before it plans anything, so a repair never depends on the planner happening to
    /// re-derive the same blob id.
    public func orphanedBlobIds() throws -> [String] {
        lock.lock(); defer { lock.unlock() }
        return try run("""
            SELECT DISTINCT m.blobId FROM blob_members m
              JOIN blobs b ON b.id = m.blobId
              LEFT JOIN files f ON f.id = m.fileId
             WHERE b.status = ?1 AND (f.status IS NULL OR (f.status != ?2 AND f.deletedAt IS NULL))
            """, [.text(BlobStatus.verified.rawValue), .text(FileStatus.archived.rawValue)])
            .compactMap { $0["blobId"] as? String }
    }

    /// Verified blobs whose members are **all** tombstoned — the only bytes that can be reclaimed at object
    /// granularity, and the reap pass's whole input.
    ///
    /// **Why this catches most real deletions.** A blob holds one folder's files (`BlobPlanner` buckets by
    /// folder), and people delete folders — "I don't need the 2019 shoot any more". That deletion shape lines
    /// up with blob boundaries, so whole blobs go dead together. Scattered deletes inside a folder that's
    /// still live reclaim nothing, because a blob is one S3 object and its live members are in it; that
    /// residue needs a repack, which Deep Archive makes uneconomic (reading the bytes back to rewrite them
    /// costs ~90× a year of storing them). So: reap what the shape gives us, and be honest about the rest.
    ///
    /// Deliberately conservative — a member with NO file row at all counts as alive, so a journal that has
    /// lost track of a file can never cause its bytes to be reclaimed. Reaping is irreversible; guessing isn't
    /// allowed.
    public func fullyDeletedBlobIds() throws -> [String] {
        lock.lock(); defer { lock.unlock() }
        return try run("""
            SELECT m.blobId FROM blob_members m
              JOIN blobs b ON b.id = m.blobId
              LEFT JOIN files f ON f.id = m.fileId
             WHERE b.status = ?1
             GROUP BY m.blobId
            HAVING SUM(CASE WHEN f.deletedAt IS NULL THEN 1 ELSE 0 END) = 0
            """, [.text(BlobStatus.verified.rawValue)])
            .compactMap { $0["blobId"] as? String }
    }

    /// Record that we are ABOUT to tag this blob's object for expiry — written before the S3 call, so the
    /// intent survives a crash mid-reclaim. Without it, a daemon that died between the tag and
    /// `markBlobReaped` left a `verified` blob whose bytes S3 was quietly scheduled to delete, and nothing
    /// could tell: re-depositing those files re-linked them to an object already on its way out.
    public func markBlobReapTagIntent(_ blobId: String) throws {
        lock.lock(); defer { lock.unlock() }
        try run("UPDATE blobs SET reapTaggedAt=COALESCE(reapTaggedAt, ?1) WHERE id=?2",
                [.int(Int(Date().timeIntervalSince1970)), .text(blobId)])
    }

    /// Record that a blob's object has been tagged for lifecycle expiry. Moves it out of `verified`, so
    /// `fullyDeletedBlobIds` won't hand it back and the next pass won't re-tag it.
    public func markBlobReaped(_ blobId: String) throws {
        lock.lock(); defer { lock.unlock() }
        try run("UPDATE blobs SET status=?1 WHERE id=?2", [.text(BlobStatus.reaped.rawValue), .text(blobId)])
    }

    /// Record that a blob's reap tag has been CLEARED in S3 — the object is no longer queued for expiry.
    /// Written only after the untag succeeds (see `reviveFiles`).
    public func clearReapTag(_ blobId: String) throws {
        lock.lock(); defer { lock.unlock() }
        try run("UPDATE blobs SET reapTaggedAt=NULL WHERE id=?1", [.text(blobId)])
    }

    /// Deep Archive's minimum billable storage duration. The clock the user's space comes back on, because
    /// it is the clock our bill comes off.
    ///
    /// A copy of `minimumStorageDays` in the root `reclaim.constants.json` — the same number the bucket's
    /// lifecycle rule expires on, so the two MUST agree or the credit hands back space we are still paying
    /// for. Swift can't read the file at compile time; `ReclaimConstantsTests` pins this literal to it
    /// instead. Edit the JSON, not this line.
    public static let minimumStorageDays = 180

    /// Bytes to give back to the user that S3 is still listing.
    ///
    /// **Why this exists.** Usage is measured from a live `ListObjectsV2`, which keeps returning an object
    /// until it is physically removed — and S3 evaluates lifecycle rules only once a day, then removes
    /// objects some time after that. Tying the user's free space to that schedule means deleting a folder
    /// and immediately re-uploading fails for reasons no one could explain.
    ///
    /// **Why it's safe to give it back early.** AWS stops charging at *eligibility*, not at removal: "if an
    /// object is scheduled to expire and Amazon S3 doesn't immediately expire the object, you won't be
    /// charged for storage after the expiration time." So crediting at eligibility hands the user space at
    /// the same moment our cost for it ends — not one second sooner, which is what makes churn unprofitable
    /// to attempt.
    ///
    /// A reaped blob younger than the minimum is NOT credited: we are still paying for it, so the user is
    /// still holding it. That is the whole anti-churn property, and it falls out of one `WHERE` clause.
    /// How long a credit stays valid after the blob became eligible. The credit exists ONLY to bridge the
    /// gap between "AWS stopped charging" (eligibility) and "S3 stopped listing it" (the sweep, which runs
    /// once a day). Once the object is gone from the listing, `listed` has already dropped by those bytes —
    /// so a credit that never expires subtracts them a SECOND time, permanently, and the error compounds
    /// with every delete until the quota ceiling is meaningless.
    ///
    /// A week is generous for a daily sweep. Erring past the window under-credits (the user briefly sees
    /// usage they've actually freed) rather than over-crediting, which would let them overrun their plan.
    /// The exact alternative is to credit only blobs whose key is still in the listing — see the note in
    /// `DaemonService.currentUsageBytes`.
    public static let creditGraceDays = 7

    public func reclaimedCreditBytes(now: Date = Date()) throws -> Int {
        lock.lock(); defer { lock.unlock() }
        let nowSecs = Int(now.timeIntervalSince1970)
        let eligibleBefore = nowSecs - Self.minimumStorageDays * 86_400
        let staleBefore = nowSecs - (Self.minimumStorageDays + Self.creditGraceDays) * 86_400
        let rows = try run("""
            SELECT SUM(f.size) AS bytes FROM blobs b
              JOIN blob_members m ON m.blobId = b.id
              JOIN files f ON f.id = m.fileId
             WHERE b.status = ?1 AND b.archivedAt IS NOT NULL
               AND b.archivedAt <= ?2 AND b.archivedAt > ?3
               AND f.deletedAt IS NOT NULL
            """, [.text(BlobStatus.reaped.rawValue), .int(eligibleBefore), .int(staleBefore)])
        return (rows.first?["bytes"] as? Int) ?? 0
    }

    /// Files the planner must NOT plan, for two different reasons that both end in "leave it alone":
    ///
    /// - **`archived`** — the bytes are already in S3 under a blob id derived from the membership they had
    ///   when sealed. Re-planning them alongside newly-arrived neighbours mints a different id, misses the
    ///   `isBlobVerified` check, and re-uploads what's already stored.
    /// - **tombstoned** — the user removed it. Skipping it in `upsert` is not enough on its own: the row
    ///   would still be planned, uploaded, and marked `archived` again, resurrecting it through the back
    ///   door. A deletion has to hold all the way through the pipeline, not just at discovery.
    public func settledFileIds() throws -> Set<String> {
        lock.lock(); defer { lock.unlock() }
        return Set(try run("SELECT id FROM files WHERE status = ?1 OR deletedAt IS NOT NULL",
                           [.text(FileStatus.archived.rawValue)])
            .compactMap { $0["id"] as? String })
    }

    public func uploadId(of blobId: String) throws -> String? {
        lock.lock(); defer { lock.unlock() }
        return try run("SELECT uploadId FROM blobs WHERE id=?1", [.text(blobId)]).first?["uploadId"] as? String
    }

    /// The blob's stored S3 key — the SSOT for where its bytes live, set at `ensureBlob` from `plan.s3Key`
    /// (which carries the per-user prefix). Restore reads THIS rather than recomputing `"blobs/<id>"`, so a
    /// per-user-prefixed object (`blobs/<cognito-id>/<id>`) is found correctly. `s3Key` is NOT NULL, so a
    /// known blob always has one.
    public func blobS3Key(_ blobId: String) throws -> String? {
        lock.lock(); defer { lock.unlock() }
        return try run("SELECT s3Key FROM blobs WHERE id=?1", [.text(blobId)]).first?["s3Key"] as? String
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
        return (count("SELECT count(*) c FROM files WHERE deletedAt IS NULL AND status != 'folder'"),
                count("SELECT count(*) c FROM files WHERE deletedAt IS NULL AND status='archived'"),
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

    /// Mark a blob verified AND link every one of its files into the tree, **atomically**.
    ///
    /// These used to be separate writes — `markBlobVerified`, then a `markFileArchived` loop — and a crash in
    /// between produced an orphan: bytes verified in S3, tree showing nothing. One transaction closes that
    /// window, so a blob is either fully linked or not verified at all, and the file set of a verified blob is
    /// never partial. That totality is what lets the planner safely exclude archived files: membership splits
    /// cleanly into "all archived" or "none", never halfway through a blob.
    ///
    /// Idempotent, and safe on the repair path — re-asserting `verified` on an already-verified blob is a
    /// no-op, so this is also how a recovered orphan gets re-linked.
    public func markBlobArchived(_ blobId: String, spans: [FileSpan]) throws {
        lock.lock(); defer { lock.unlock() }
        try transaction {
        // `reapTaggedAt` is cleared here because this blob's object has just been (re)written: a fresh object
        // version carries no tags, so any expiry we had queued against the old one is gone with it.
        try run("UPDATE blobs SET status=?1, archivedAt=COALESCE(archivedAt, ?3), reapTaggedAt=NULL WHERE id=?2",
                [.text(BlobStatus.verified.rawValue), .text(blobId), .int(Int(Date().timeIntervalSince1970))])
        for s in spans {
            try run("""
                UPDATE files SET status=?1, blobId=?2, "offset"=?3, length=?4, firstFrame=?5, plaintextSha256=?6,
                    size=?7, error=NULL WHERE id=?8 AND deletedAt IS NULL
                """, [.text(FileStatus.archived.rawValue), .text(blobId), .int(s.offset), .int(s.length),
                      .int(s.firstFrame), .text(s.plaintextSha256), .int(s.size), .text(s.id)])
        }
        }
    }

    /// `size` is the EXACT plaintext byte count measured while staging — the SSOT for the file's real size.
    /// It overwrites the discovery-time estimate, which is 0 for a Photos asset (unknown until streamed) and
    /// only stat-derived for a local file. `length` is the *ciphertext* span and is unrelated (it's larger:
    /// plaintext + per-frame AEAD tags).
    public func markFileArchived(_ id: String, blobId: String, offset: Int, length: Int, firstFrame: Int, plaintextSha256: String, size: Int) throws {
        lock.lock(); defer { lock.unlock() }
        // `error=NULL` because a recorded fault is history the moment the thing succeeds — the same rule
        // `setRestoreState` follows. It was harmless while nothing read `files.error`; the instant the tree
        // started showing the reason, a stale note would pin "couldn't upload" to a file that is safely
        // stored. `lastAttemptAt` is stamped from SQLite's own clock so no call site has to thread a
        // timestamp through (and every write here means exactly "we just tried, now").
        try run("""
            UPDATE files SET status=?1, blobId=?2, "offset"=?3, length=?4, firstFrame=?5, plaintextSha256=?6,
              size=?7, error=NULL, lastAttemptAt=CAST(strftime('%s','now') AS INTEGER) WHERE id=?8
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
            // **Never flip an ARCHIVED file to failed.** A file whose bytes are verified in S3 is archived,
            // full stop — a *later* blob's failure says nothing about it. Without this guard, any blob that
            // re-plans an already-stored file (and then fails, or is refused over quota) marks that file ⚠ in
            // the tree, telling the user a backup they already have didn't happen. The bytes are fine either
            // way; the lie is the damage, and it is the one claim this product cannot afford to get wrong.
            try run("""
                UPDATE files SET status=?1, error=?2, lastAttemptAt=CAST(strftime('%s','now') AS INTEGER)
                WHERE id=?3 AND status!=?4
                """, [.text(FileStatus.failed.rawValue), .text(error), .text(id), .text(FileStatus.archived.rawValue)])
        }
    }

    /// Record a TRANSIENT upload fault against a blob's files: why the last attempt failed, and that one was
    /// made — without touching `status`, so the run loop picks them up again next pass.
    ///
    /// The gap this fills is the upload twin of `recordRestoreFault`. A transient blob failure used to touch
    /// the journal not at all: the fault went out as a `blobFailed` bus EVENT and nowhere else, so a file
    /// whose upload kept failing sat at `planned` — which the tree renders as "Uploading" — with no record
    /// and no clock. If the app wasn't open when the event fired, there was no trace of it anywhere. The
    /// permanent and over-quota cases were already given journal truth (`markFilesFailed`); this is the
    /// third case, and the one that repeats.
    ///
    /// Same never-touch-an-archived-file guard as `markFilesFailed`, for exactly the reason given there: a
    /// later blob's snag says nothing about bytes already verified in S3.
    public func recordFileFault(_ ids: [String], error: String) throws {
        guard !ids.isEmpty else { return }
        lock.lock(); defer { lock.unlock() }
        for id in ids {
            try run("""
                UPDATE files SET error=?1, lastAttemptAt=CAST(strftime('%s','now') AS INTEGER)
                WHERE id=?2 AND status!=?3
                """, [.text(error), .text(id), .text(FileStatus.archived.rawValue)])
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
