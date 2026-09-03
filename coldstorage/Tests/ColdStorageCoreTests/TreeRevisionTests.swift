import Testing
import Foundation
import Crypto
@testable import ColdStorageCore

/// **The tree revision** (`DaemonService.treeRevision`) — the app's reconciliation clock for optimistic
/// edits. Pins the contract the UI's `overlay.ts` depends on: every tree-editing ack names the revision
/// its edit landed at, `listFiles` names the revision it was read at, the two agree, and `filesChanged`
/// carries the same number. A `deposit` acks the batch id it minted, so the run events can carry it back.
@Suite struct TreeRevisionTests {
    private func makeDaemon() async throws -> (DaemonService, EventBus, URL) {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("cs-rev-\(UUID().uuidString)")
        let bus = EventBus()
        let sessions = SessionFactory(dataRoot: root.appendingPathComponent("data"), store: FakeVault(), canSelfThaw: false)
        let daemon = DaemonService(bus: bus, sessions: sessions)
        let session = try sessions.make(.user(sub: "s", identityId: "ca-central-1:1"))
        session.vaultKey.setMasterKey(SymmetricKey(size: .bits256))
        await daemon.beginSession(session)
        return (daemon, bus, root)
    }

    private func json(_ daemon: DaemonService, _ id: Int, _ method: String, _ params: [String: String] = [:]) async throws -> [String: Any] {
        let line = await daemon.respond(to: ControlRequest(id: id, method: method, params: params))
        #expect(line.error == nil, "\(method): \(line.error ?? "")")
        return try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(line.result)) as? [String: Any])
    }

    @Test func acksAndReadsAgreeOnTheRevision() async throws {
        let (daemon, bus, root) = try await makeDaemon()
        defer { try? FileManager.default.removeItem(at: root) }
        let seen = LockedBox<[String]>([])
        _ = bus.subscribe { e in if e.name == "filesChanged", let r = e.data["revision"] { seen.mutate { $0.append(r) } } }

        let before = try #require(try await json(daemon, 1, "listFiles")["revision"] as? Int)

        // createFolder: the ack's revision is the next one, and the read at it shows the folder.
        let created = try await json(daemon, 2, "createFolder", ["path": "Taxes"])
        let r1 = try #require(created["revision"] as? Int)
        #expect(r1 == before + 1)
        let listed = try await json(daemon, 3, "listFiles")
        #expect(listed["revision"] as? Int == r1)
        let files = try #require(listed["files"] as? [[String: Any]])
        #expect(files.contains { $0["relativePath"] as? String == "Taxes" && $0["status"] as? String == "folder" })

        // movePath (the rename primitive) and deletePath each land at the next revision, in order.
        let moved = try await json(daemon, 4, "movePath", ["from": "Taxes", "to": "Papers"])
        #expect(moved["revision"] as? Int == r1 + 1)
        let deleted = try await json(daemon, 5, "deletePath", ["path": "Papers"])
        #expect(deleted["revision"] as? Int == r1 + 2)
        #expect(try await json(daemon, 6, "listFiles")["revision"] as? Int == r1 + 2)

        // The events said the same numbers, in the same order — the live watcher and the ack agree.
        #expect(seen.value.suffix(3) == ["\(r1)", "\(r1 + 1)", "\(r1 + 2)"])
    }

    @Test func depositAcksTheBatchIdItMinted() async throws {
        let (daemon, bus, root) = try await makeDaemon()
        defer { try? FileManager.default.removeItem(at: root) }
        let src = root.appendingPathComponent("drop.txt")
        try "hello".data(using: .utf8)!.write(to: src)
        let finished = AsyncStream<DaemonEvent> { c in _ = bus.subscribe { e in if e.name == "runFinished" { c.yield(e) } } }

        let ack = try await json(daemon, 1, "deposit", ["src": src.path, "dest": ""])
        let depositId = try #require(ack["depositId"] as? String)
        #expect(!depositId.isEmpty)

        // The run for THAT batch closes out naming it, with the revision its rows are final at — the read
        // at or past that revision is the first that reflects the outcome.
        let event = try await withThrowingTimeout(seconds: 10) {
            for await e in finished { return e }
            throw CancellationError()
        }
        #expect(event.data["depositId"] == depositId)
        let rev = try #require(event.data["revision"].flatMap(Int.init))
        let listed = try await json(daemon, 2, "listFiles")
        #expect(try #require(listed["revision"] as? Int) >= rev)
        let rows = try #require(listed["files"] as? [[String: Any]])
        #expect(rows.contains { $0["relativePath"] as? String == "drop.txt" && $0["depositId"] as? String == depositId })
    }
}

/// A tiny lock for collecting events off the bus's callback thread inside a test.
private final class LockedBox<T>: @unchecked Sendable {
    private var v: T
    private let lock = NSLock()
    init(_ v: T) { self.v = v }
    var value: T { lock.withLock { v } }
    func mutate(_ f: (inout T) -> Void) { lock.withLock { f(&v) } }
}
