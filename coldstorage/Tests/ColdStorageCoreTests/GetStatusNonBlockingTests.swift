import Testing
import Foundation
import Crypto
@testable import ColdStorageCore

/// **`getStatus` must never wait on the network.** `bytesStored` is backed by a paginated S3 listing
/// (~one round trip per 1,000 objects). On a flaky link those calls retry and hang; because every command
/// shares the daemon actor, a `getStatus` stuck on S3 dragged `listFiles`/`authenticate`/`setQuota` past
/// the client's 10 s deadline — the app timed out on everything while the daemon sat idle in a URLSession
/// read (2026-08-25). This pins the fix: with a vault whose usage listing BLOCKS FOREVER, `getStatus` still
/// returns immediately (journal-only) with `bytesStored == nil`, and other commands stay responsive.
@Suite struct GetStatusNonBlockingTests {

    /// A store that DELEGATES everything to a real FakeVault but hangs forever on `usageBytes` — the
    /// flaky-network worst case, made deterministic. Wraps rather than subclasses (`FakeVault` is final).
    final class HangingUsageVault: Vault, @unchecked Sendable {
        let inner = FakeVault()
        func usageBytes(prefix: VaultPrefix) async throws -> Int {
            try await Task.sleep(for: .seconds(3600)); return 0
        }
        func thawState(key: String) async throws -> ThawState { try await inner.thawState(key: key) }
        func requestThaw(key: String, days: Int, tier: RestoreTier) async throws { try await inner.requestThaw(key: key, days: days, tier: tier) }
        func getRange(key: String, offset: Int, length: Int) async throws -> AsyncThrowingStream<Data, Error> { try await inner.getRange(key: key, offset: offset, length: length) }
        func createUpload(key: String) async throws -> String { try await inner.createUpload(key: key) }
        func existingParts(key: String, uploadId: String) async throws -> Set<Int>? { try await inner.existingParts(key: key, uploadId: uploadId) }
        func uploadPart(key: String, uploadId: String, number: Int, data: Data) async throws -> (etag: String, sha: String) { try await inner.uploadPart(key: key, uploadId: uploadId, number: number, data: data) }
        func complete(key: String, uploadId: String, parts: [PartRow]) async throws { try await inner.complete(key: key, uploadId: uploadId, parts: parts) }
        func verify(key: String) async throws { try await inner.verify(key: key) }
        func markReclaimable(key: String) async throws { try await inner.markReclaimable(key: key) }
        func unmarkReclaimable(key: String) async throws { try await inner.unmarkReclaimable(key: key) }
    }

    @Test func getStatusReturnsImmediatelyWhileUsageListingHangs() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("cs-gs-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let sessions = SessionFactory(dataRoot: root.appendingPathComponent("data"), store: HangingUsageVault(), canSelfThaw: false)
        let daemon = DaemonService(bus: EventBus(), sessions: sessions)
        let session = try sessions.make(.user(sub: "s", identityId: "ca-central-1:1"))
        session.vaultKey.setMasterKey(SymmetricKey(size: .bits256))
        await daemon.beginSession(session)

        // getStatus resolves fast even though the usage listing would hang for an hour.
        let t = ContinuousClock.now
        let r = await daemon.respond(to: ControlRequest(id: 1, method: "getStatus", params: [:]))
        let elapsed = ContinuousClock.now - t
        #expect(elapsed < .seconds(2))
        #expect(r.error == nil)

        // A second command right after is equally responsive — the actor was never pinned.
        let t2 = ContinuousClock.now
        _ = await daemon.respond(to: ControlRequest(id: 2, method: "listFiles", params: [:]))
        #expect(ContinuousClock.now - t2 < .seconds(2))
    }

    /// The other half of "never wait": when the background listing DOES land, the daemon must say so.
    /// The UI re-reads status only on daemon events, so a silent cache fill leaves the storage meter on
    /// its skeleton for the whole session. Pins `usageChanged` — published once the cache is filled, with
    /// the figure — and that a `getStatus` after it carries `bytesStored`.
    @Test func usageChangedFiresWhenTheBackgroundListingLands() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("cs-gs-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let bus = EventBus()
        let sessions = SessionFactory(dataRoot: root.appendingPathComponent("data"), store: FakeVault(), canSelfThaw: false)
        let daemon = DaemonService(bus: bus, sessions: sessions)
        let session = try sessions.make(.user(sub: "s", identityId: "ca-central-1:1"))
        session.vaultKey.setMasterKey(SymmetricKey(size: .bits256))

        let landed = AsyncStream<DaemonEvent> { continuation in
            _ = bus.subscribe { e in if e.name == "usageChanged" { continuation.yield(e) } }
        }
        await daemon.beginSession(session)

        // Cold cache: this answer has no figure, and it kicks the background listing.
        let first = await daemon.respond(to: ControlRequest(id: 1, method: "getStatus", params: [:]))
        let firstStatus = try JSONSerialization.jsonObject(with: JSONEncoder().encode(first.result)) as? [String: Any]
        #expect(firstStatus?["bytesStored"] is NSNull || firstStatus?["bytesStored"] == nil)

        // The event arrives (bounded — a hang here IS the bug), carrying the number.
        let event = try await withThrowingTimeout(seconds: 5) {
            for await e in landed { return e }
            throw CancellationError()
        }
        #expect(event.data["bytesStored"] == "0")

        // And the next status read serves it from the cache.
        let second = await daemon.respond(to: ControlRequest(id: 2, method: "getStatus", params: [:]))
        let secondStatus = try JSONSerialization.jsonObject(with: JSONEncoder().encode(second.result)) as? [String: Any]
        #expect(secondStatus?["bytesStored"] as? Int == 0)

        // Stale-while-revalidate: a run just EXPIRED the cache (what's in S3 changed), and the figure must
        // still be served — never `nil` — while the background listing catches up. Reporting `nil` here
        // blanked the storage meter after every run and every status re-read past the TTL (2026-09-03).
        try await daemon.runOnce()
        let third = await daemon.respond(to: ControlRequest(id: 3, method: "getStatus", params: [:]))
        let thirdStatus = try JSONSerialization.jsonObject(with: JSONEncoder().encode(third.result)) as? [String: Any]
        #expect(thirdStatus?["bytesStored"] as? Int == 0)
    }
}
