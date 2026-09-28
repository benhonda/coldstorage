import Testing
import Foundation
import Crypto
import Csqlite3
@testable import ColdStorageCore

/// **The tree's change feed** (`Journal.filesPage`, `listFiles`). The app loads the tree a page at a time,
/// then asks only for what changed — because on a real vault (903,751 files, 2026-09-27) the whole tree in one
/// reply was 556 MiB, past what the app's JavaScript can hold as a string, and it was re-sent after every
/// edit. These pin what that has to get right: every row served exactly once, every write noticed (triggers,
/// not call sites), deletions delivered only to a reader that could hold the row, and a wire row that is
/// valid JSON whatever its path holds.
@Suite struct FilesFeedTests {
    private func tempJournal() throws -> (Journal, String) {
        let path = FileManager.default.temporaryDirectory.appendingPathComponent("cs-feed-\(UUID().uuidString).sqlite").path
        return (try Journal(path: path), path)
    }

    private func item(_ path: String, hash: String = "h", metadata: FileMetadata = FileMetadata()) -> IngestItem {
        IngestItem(id: path, relativePath: path, size: 1, content: .sha256("\(hash)-\(path)"), isFavorite: false,
                   metadata: metadata, sourcePath: "/Users/me/\(path)", open: { AsyncThrowingStream { $0.finish() } })
    }

    /// Every page from `after` until the feed says there is no more.
    private func drain(_ j: Journal, after: Journal.FileCursor, knownDeletedUpTo: Int? = nil, limit: Int)
        async throws -> (files: [FileRow], removed: [String], cursor: Journal.FileCursor, pages: Int) {
        var files: [FileRow] = [], removed: [String] = [], cursor = after, pages = 0
        while true {
            let page = try await j.filesPage(after: cursor, knownDeletedUpTo: knownDeletedUpTo, limit: limit)
            files += page.files; removed += page.removed; cursor = page.cursor; pages += 1
            if !page.more { return (files, removed, cursor, pages) }
        }
    }

    @Test func pagesServeEveryRowOnceInTheOrderItChanged() async throws {
        let (j, _) = try tempJournal()
        try j.upsert((1...7).map { item("Drop/\($0).jpg") })
        var cursor = Journal.FileCursor.start
        var seen: [String] = []
        var shape: [(Int, Bool)] = []
        while true {
            let page = try await j.filesPage(after: cursor, knownDeletedUpTo: nil, limit: 3)
            seen += page.files.map(\.id); shape.append((page.files.count, page.more)); cursor = page.cursor
            if !page.more { break }
        }
        #expect(seen == (1...7).map { "Drop/\($0).jpg" })   // insertion order is change order
        #expect(shape.map(\.0) == [3, 3, 1] && shape.map(\.1) == [true, true, false])
        #expect(cursor.rev == (try j.maxRev()))
        // Nothing changed since: a catch-up read from the end is empty, and stays put.
        let idle = try await j.filesPage(after: cursor, knownDeletedUpTo: nil, limit: 3)
        #expect(idle.files.isEmpty && idle.removed.isEmpty && !idle.more && idle.cursor == cursor)
    }

    /// Every kind of write lands in the feed — the triggers stamp it, so no write path can forget to.
    @Test func everyWriteIsInTheCatchUp() async throws {
        let (j, _) = try tempJournal()
        try j.upsert(["a.jpg", "b.jpg", "c.jpg", "d.jpg", "e.jpg"].map { item($0) })
        let loaded = try await drain(j, after: .start, limit: 100).cursor

        try j.movePath(from: "a.jpg", to: "Moved/a.jpg")                           // rename
        try j.markFilesFailed(["b.jpg"], kind: .missingSource)                      // a status change
        try j.markFileArchived("c.jpg", blobId: "b1", offset: 0, length: 1, firstFrame: 0, plaintextSha256: "x", size: 1)
        try j.deletePath("d.jpg")                                                   // a tombstone
        try j.createFolder(path: "Empty")                                           // a new row
        try j.upsert([item("e.jpg", hash: "edited")])                               // a re-scan that changed it

        let delta = try await drain(j, after: loaded, limit: 100)
        #expect(Set(delta.files.filter { $0.status != .folder }.map(\.id)) == ["a.jpg", "b.jpg", "c.jpg", "e.jpg"])
        #expect(delta.files.first { $0.id == "a.jpg" }?.relativePath == "Moved/a.jpg")
        #expect(delta.files.first { $0.id == "b.jpg" }?.status == .failed)
        #expect(delta.files.contains { $0.status == .folder && $0.relativePath == "Empty" })
        #expect(delta.removed == ["d.jpg"])
        #expect(delta.cursor.rev == (try j.maxRev()))
    }

    /// A fresh load never hears about rows deleted before it began (it never had them); a row deleted WHILE
    /// it loads is still removed, because the load may already have handed it over.
    @Test func aFreshLoadIsToldOnlyAboutDeletionsItCouldHaveSeen() async throws {
        let (j, _) = try tempJournal()
        try j.upsert(["gone-before.jpg", "a.jpg", "b.jpg", "c.jpg"].map { item($0) })
        try j.deletePath("gone-before.jpg")

        let first = try await j.filesPage(after: .start, knownDeletedUpTo: nil, limit: 2)
        #expect(first.removed.isEmpty)
        #expect(first.files.map(\.id) == ["a.jpg", "b.jpg"])
        try j.deletePath("a.jpg")   // deleted mid-load, after the reader already has it

        let rest = try await drain(j, after: first.cursor, knownDeletedUpTo: first.head, limit: 2)
        #expect(rest.removed == ["a.jpg"])
        #expect(rest.files.map(\.id) == ["c.jpg"])
    }

    /// Rows from before the feed existed all carry `rev` 0; they're ordered by rowid and every one is served,
    /// across pages, before anything newer.
    @Test func rowsFromBeforeTheFeedAreAllServed() async throws {
        let (j, path) = try tempJournal()
        try j.upsert((1...5).map { item("old/\($0).jpg") })
        var db: OpaquePointer?
        try #require(sqlite3_open_v2(path, &db, SQLITE_OPEN_READWRITE, nil) == SQLITE_OK)
        try #require(sqlite3_exec(db, "UPDATE files SET rev = 0", nil, nil, nil) == SQLITE_OK)   // as the migration leaves them
        sqlite3_close(db)
        try j.upsert([item("new.jpg")])

        let all = try await drain(j, after: .start, limit: 2)
        #expect(all.files.map(\.id) == (1...5).map { "old/\($0).jpg" } + ["new.jpg"])
        #expect(all.pages == 3)
    }

    // MARK: - the wire (`listFiles`)

    private func signedIn() async throws -> (DaemonService, UserSession, URL) {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("cs-feed-\(UUID().uuidString)")
        let sessions = SessionFactory(dataRoot: root, store: FakeVault(), canSelfThaw: false)
        let daemon = DaemonService(bus: EventBus(), sessions: sessions)
        let session = try sessions.make(.user(sub: "s", identityId: "ca-central-1:1"))
        session.vaultKey.setMasterKey(SymmetricKey(size: .bits256))
        await daemon.beginSession(session)
        return (daemon, session, root)
    }

    private func page(_ daemon: DaemonService, _ params: [String: String] = [:]) async throws -> [String: Any] {
        let line = await daemon.respond(to: ControlRequest(id: 1, method: "listFiles", params: params))
        #expect(line.error == nil, "\(line.error ?? "")")
        return try #require(try line.wireResult() as? [String: Any])
    }

    /// A row carries what the app reads and nothing else: no `id` while it equals the path, no nulls, no
    /// `blobId`, and `sourcePath` only once the row has failed (that's what Try again / Locate… need).
    @Test func aRowOnTheWireCarriesOnlyWhatTheAppReads() async throws {
        let (daemon, s, root) = try await signedIn()
        defer { try? FileManager.default.removeItem(at: root) }
        try s.journal.upsert([item("a.txt", metadata: FileMetadata(modifiedAt: 1_700_000_000, createdAt: 1_600_000_000))])

        let fresh = try await page(daemon)
        let row = try #require((fresh["files"] as? [[String: Any]])?.first)
        #expect(Set(row.keys) == ["relativePath", "size", "status", "modifiedAt", "createdAt"])
        #expect(row["modifiedAt"] as? Int == 1_700_000_000 && row["createdAt"] as? Int == 1_600_000_000)
        #expect(fresh["more"] as? Bool == false)
        #expect(fresh["revision"] as? Int == fresh["head"] as? Int)

        try s.journal.markFilesFailed(["a.txt"], kind: .missingSource)
        try s.journal.movePath(from: "a.txt", to: "Moved/a.txt")
        let caughtUp = try await page(daemon, ["after": try #require(fresh["cursor"] as? String)])
        let changed = try #require((caughtUp["files"] as? [[String: Any]])?.first)
        #expect(changed["id"] as? String == "a.txt" && changed["relativePath"] as? String == "Moved/a.txt")
        #expect(changed["sourcePath"] as? String == "/Users/me/a.txt")
        #expect(changed["failureKind"] as? String == "missingSource")
        #expect(changed["blobId"] == nil)
    }

    /// An edit's ack names a revision; the first catch-up read after it reaches that revision and carries the
    /// edit — the contract the app's optimistic overlay settles on.
    @Test func aCatchUpReadReachesTheRevisionAnEditWasAckedAt() async throws {
        let (daemon, _, root) = try await signedIn()
        defer { try? FileManager.default.removeItem(at: root) }
        let fresh = try await page(daemon)
        let ack = await daemon.respond(to: ControlRequest(id: 2, method: "createFolder", params: ["path": "Taxes"]))
        let acked = try #require((try ack.wireResult() as? [String: Any])?["revision"] as? Int)
        let caughtUp = try await page(daemon, ["after": try #require(fresh["cursor"] as? String)])
        #expect(try #require(caughtUp["revision"] as? Int) >= acked)
        #expect((caughtUp["files"] as? [[String: Any]])?.contains { $0["relativePath"] as? String == "Taxes" } == true)
    }

    /// A path can hold anything a macOS filename can — quotes, backslashes, a newline — and the page is still
    /// valid JSON that gives the exact path back.
    @Test func anyPathSurvivesTheWire() async throws {
        let (daemon, s, root) = try await signedIn()
        defer { try? FileManager.default.removeItem(at: root) }
        let odd = "Drop/\"quoted\" back\\slash\nnew line\ttab\u{1}bell — ünïcødé 📁.txt"
        try s.journal.upsert([item(odd)])
        let rows = try #require(try await page(daemon)["files"] as? [[String: Any]])
        #expect(rows.first?["relativePath"] as? String == odd)
    }

    @Test func aMalformedCursorIsRefused() async throws {
        let (daemon, _, root) = try await signedIn()
        defer { try? FileManager.default.removeItem(at: root) }
        let line = await daemon.respond(to: ControlRequest(id: 1, method: "listFiles", params: ["after": "nope"]))
        #expect(line.error?.contains("malformed cursor") == true)
    }
}
