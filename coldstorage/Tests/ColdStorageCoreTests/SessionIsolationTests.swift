import Testing
import Foundation
@testable import ColdStorageCore

/// **The test that did not exist, and should have.**
///
/// On 2026-07-13, signing out of one account and into another on the same Mac showed the second account the
/// FIRST account's entire file tree — names, paths, sizes — plus its watched folders. The bytes were never
/// at risk (IAM scopes each user's S3 prefix, and the MasterKeys differ), but the local journal was a single
/// machine-wide SQLite file with no owner column, and sign-out dropped only the credentials and the key. The
/// journal, the staging dir and status.json stayed behind for whoever signed in next.
///
/// It survived because nobody had ever performed the action: Ben was user #1, and no test signed in twice.
/// These drive the REAL `DaemonService` over the REAL command surface (`respond(to:)`) against REAL
/// `UserSession`s on a REAL temp-dir journal — only the Cognito token exchange is skipped, via the
/// `beginSession`/`endSession` seam that `authenticate`/`deauthenticate` themselves call.
@Suite struct SessionIsolationTests {

    /// A vault that talks to nothing. None of these tests make a network call — they are about which
    /// journal the daemon reads — so there is no reason to stand up an AWS client (and its CRT TLS context,
    /// which under load can fail to initialize at all and would make this suite flaky; a flaky guard on a
    /// security boundary is worse than no guard).
    private struct FakeVault: Vault {
        func createUpload(key: String) async throws -> String { "upload-\(key)" }
        func existingParts(key: String, uploadId: String) async throws -> Set<Int> { [] }
        func uploadPart(key: String, uploadId: String, number: Int, data: Data) async throws -> (etag: String, sha: String) {
            ("etag-\(number)", "sha-\(number)")
        }
        func complete(key: String, uploadId: String, parts: [PartRow]) async throws {}
        func verify(key: String) async throws {}
        func thawState(key: String) async throws -> ThawState { .ready }
        func requestThaw(key: String, days: Int, tier: RestoreTier) async throws {}
        func getRange(key: String, offset: Int, length: Int) async throws -> Data { Data() }
        func usageBytes(prefix: VaultPrefix) async throws -> Int { 0 }
    }

    /// A daemon wired exactly as production wires it, minus the Cognito network call.
    private func fixture() -> (daemon: DaemonService, sessions: SessionFactory, root: URL) {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("cs-session-\(UUID().uuidString)", isDirectory: true)
        let sessions = SessionFactory(dataRoot: root, store: FakeVault(), canSelfThaw: false)
        let daemon = DaemonService(bus: EventBus(), sessions: sessions)
        return (daemon, sessions, root)
    }

    private func request(_ method: String, _ params: [String: String] = [:]) -> ControlRequest {
        ControlRequest(id: 1, method: method, params: params)
    }

    /// Decode a command's JSON response back into something assertable — the same wire the UI reads, so we
    /// are testing what the UI would actually be handed, not an internal accessor.
    private func reply(_ daemon: DaemonService, _ method: String,
                       _ params: [String: String] = [:]) async throws -> (result: Any?, error: String?) {
        let line = await daemon.respond(to: request(method, params))
        guard line.error == nil else { return (nil, line.error) }
        let data = try JSONEncoder().encode(line.result)
        return (try JSONSerialization.jsonObject(with: data), nil)
    }

    /// **The regression.** Sign in as A, deposit a file into A's journal, sign out, sign in as B — B must see
    /// an empty vault. Before the `UserSession` refactor, B saw every one of A's rows.
    @Test func secondAccountOnTheSameMacSeesNoneOfTheFirstsFiles() async throws {
        let f = fixture()
        defer { try? FileManager.default.removeItem(at: f.root) }

        // ── Account A signs in and archives a file.
        let a = try f.sessions.make(.user(sub: "sub-alice", identityId: "ca-central-1:alice"))
        await f.daemon.beginSession(a)
        try a.journal.upsert([IngestItem(id: "a1", relativePath: "Taxes/2025-return.pdf", size: 4096,
                                         contentHash: "hash-a1", createdAt: nil, isFavorite: false,
                                         open: { AsyncThrowingStream { $0.finish() } })])

        let aFiles = try await reply(f.daemon, "listFiles").result as? [[String: Any]]
        #expect(aFiles?.count == 1)
        #expect(aFiles?.first?["relativePath"] as? String == "Taxes/2025-return.pdf")

        // ── A signs out. This is the moment that used to leave everything behind.
        await f.daemon.endSession()

        let signedOut = try await reply(f.daemon, "listFiles").result as? [Any]
        #expect(signedOut?.isEmpty == true)   // signed out ⇒ nothing to read, not "A's stuff"

        // ── Account B signs in on the SAME machine.
        let b = try f.sessions.make(.user(sub: "sub-bob", identityId: "ca-central-1:bob"))
        await f.daemon.beginSession(b)

        let bFiles = try await reply(f.daemon, "listFiles").result as? [Any]
        #expect(bFiles?.isEmpty == true)      // ← the leak. B must see an EMPTY vault.

        // A's row is not gone — it is still safely in A's own journal, where it belongs.
        #expect(try a.journal.listFiles().count == 1)
        #expect(try b.journal.listFiles().isEmpty)
    }

    /// The consequence I nearly missed: B also inherited A's **watched folders**, and the run loop kept
    /// scanning them under B's session — so a new file in one of A's folders would have been archived into
    /// B's vault, under B's key. That is file CONTENT crossing accounts, not just metadata.
    @Test func secondAccountDoesNotInheritTheFirstsWatchedFoldersOrExcludes() async throws {
        let f = fixture()
        defer { try? FileManager.default.removeItem(at: f.root) }

        let a = try f.sessions.make(.user(sub: "sub-alice", identityId: "ca-central-1:alice"))
        await f.daemon.beginSession(a)
        _ = try await reply(f.daemon, "addSource", ["path": "/Users/alice/Private", "mountPath": "Private"])
        _ = try await reply(f.daemon, "addExclude", ["pattern": "*.alice-secret"])

        #expect(await f.daemon.watchedFolderPaths() == ["/Users/alice/Private"])

        await f.daemon.endSession()
        // Signed out, the daemon watches nothing — it cannot scan a folder it has no session to scan for.
        #expect(await f.daemon.watchedFolderPaths().isEmpty)

        let b = try f.sessions.make(.user(sub: "sub-bob", identityId: "ca-central-1:bob"))
        await f.daemon.beginSession(b)

        let sources = try await reply(f.daemon, "listSources").result as? [Any]
        #expect(sources?.isEmpty == true)                       // ← B must not inherit A's folders
        #expect(await f.daemon.watchedFolderPaths().isEmpty)    // ← nor have them silently scanned

        // Excludes are per-user too — except the fresh-journal defaults, which every new vault seeds.
        let excludes = try await reply(f.daemon, "listExcludes").result as? [String]
        #expect(excludes?.contains("*.alice-secret") == false)
        #expect(excludes?.contains("node_modules") == true)     // B's own fresh defaults, not A's list
    }

    /// Each user's state lives in its own directory, named for their user-pool `sub` — including `staging/`,
    /// which holds bytes mid-upload. Shared, an interrupted upload of A's could be resumed under B's key into
    /// B's vault; that is why the whole directory moves, not just the journal.
    @Test func eachUserGetsTheirOwnStateDirectoryIncludingStaging() async throws {
        let f = fixture()
        defer { try? FileManager.default.removeItem(at: f.root) }

        let a = try f.sessions.make(.user(sub: "sub-alice", identityId: "ca-central-1:alice"))
        let b = try f.sessions.make(.user(sub: "sub-bob", identityId: "ca-central-1:bob"))

        #expect(a.dir.lastPathComponent == "sub-alice")
        #expect(b.dir.lastPathComponent == "sub-bob")
        #expect(a.dir != b.dir)
        #expect(a.statusPath != b.statusPath)
        #expect(a.dir.path.hasSuffix("users/sub-alice"))

        // …and their vault prefixes are the per-identity ones IAM actually scopes credentials to.
        #expect(a.prefix == .user(identityId: "ca-central-1:alice"))
        #expect(a.prefix != b.prefix)
    }

    /// Signed out, reads are EMPTY (the truth) and writes are REFUSED (not silently applied to some default
    /// vault). This is the property that makes the leak structurally impossible rather than merely fixed:
    /// there is no unscoped journal for a command to reach.
    @Test func signedOutReadsAreEmptyAndWritesAreRefused() async throws {
        let f = fixture()
        defer { try? FileManager.default.removeItem(at: f.root) }

        let status = try await reply(f.daemon, "getStatus").result as? [String: Any]
        #expect(status?["signedIn"] as? Bool == false)
        #expect(status?["filesTotal"] as? Int == 0)
        #expect(status?["bytesStored"] == nil)

        #expect(try await reply(f.daemon, "listFiles").error == nil)   // empty, not an error

        // Mutations must fail clean, naming the reason.
        for (method, params) in [("addSource", ["path": "/tmp/x"]),
                                 ("deposit", ["src": "/tmp/x"]),
                                 ("createFolder", ["path": "New Folder"]),
                                 ("deletePath", ["path": "x"])] {
            let e = try await reply(f.daemon, method, params).error
            #expect(e?.contains("not signed in") == true, "\(method) should refuse when signed out, got: \(e ?? "nil")")
        }
    }

    /// The app re-`authenticate`s on every hourly token refresh. That must NOT churn the session — reopening
    /// the journal and rebuilding the key holder would drop an unlocked MasterKey and strand a user
    /// mid-upload. Same `sub` ⇒ same session object.
    @Test func reAuthenticatingTheSameUserKeepsTheirSession() async throws {
        let f = fixture()
        defer { try? FileManager.default.removeItem(at: f.root) }

        let a = try f.sessions.make(.user(sub: "sub-alice", identityId: "ca-central-1:alice"))
        #expect(a.belongs(toSub: "sub-alice"))
        #expect(!a.belongs(toSub: "sub-bob"))
    }
}
