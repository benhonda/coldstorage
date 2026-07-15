import Testing
import Foundation
import Crypto
@testable import ColdStorageCore

/// **The storage-quota ceiling, enforced where it can't be bypassed.** The app-side gate is fast UX, but
/// it can't see the daemon's periodic auto-run and a non-UI client sidesteps it entirely — so the real
/// ceiling lives here, in `UploadEngine.run(quota:)`. These tests exercise the actual engine against a real
/// `FakeVault`: a blob that would cross the quota is REFUSED before a byte ships (no multipart upload
/// opened, the file left un-archived), a fitting blob still lands, and `nil` means don't enforce.
@Suite struct QuotaEnforcementTests {

    /// Lay out `files` (paths may include subfolders) under a temp dir, run the engine with `quota`, and hand
    /// back the failures + the journal so a test can assert what archived and what was refused.
    private func runWithQuota(_ files: [String: Data], quota: QuotaLimit?) async throws -> (failures: [BlobFailure], journal: Journal, vault: FakeVault) {
        let fm = FileManager.default
        let base = fm.temporaryDirectory.appendingPathComponent("cs-quota-\(UUID().uuidString)")
        let root = base.appendingPathComponent("data")
        try fm.createDirectory(at: root, withIntermediateDirectories: true)
        for (name, bytes) in files {
            let url = root.appendingPathComponent(name)
            try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try bytes.write(to: url)
        }
        let journal = try Journal(path: base.appendingPathComponent("j.sqlite").path)
        let keys = LocalFileKEK(path: base.appendingPathComponent("kek.bin").path)
        let vault = FakeVault()
        let failures = try await UploadEngine(journal: journal, store: vault, keys: keys)
            .run(source: LocalDirSource(root: root), prefix: .dev, quota: quota)
        return (failures, journal, vault)
    }

    /// A single deposit that overflows the quota is refused before it uploads: it comes back as `.overQuota`,
    /// the file is NOT archived, and no multipart upload was ever opened for it (nothing shipped, nothing leaked).
    @Test func aDepositThatWouldOverflowIsRefusedBeforeUpload() async throws {
        let (failures, journal, vault) = try await runWithQuota(
            ["big.bin": Data(repeating: 0x42, count: 200_000)],
            quota: QuotaLimit(limitBytes: 50_000, usedBytes: 0))

        #expect(failures.count == 1)
        #expect(failures.first?.kind.isOverQuota == true)
        #expect(failures.first?.kind.isPermanent == false)   // retryable — it lands once there's room
        #expect(try journal.isFileArchived("big.bin") == false)
        #expect(vault.createdKeys.isEmpty)                   // refused before a single part went up
    }

    /// A deposit that fits under the quota archives normally — the ceiling only refuses what would cross it.
    @Test func aDepositThatFitsArchivesNormally() async throws {
        let (failures, journal, _) = try await runWithQuota(
            ["small.bin": Data(repeating: 0x42, count: 10_000)],
            quota: QuotaLimit(limitBytes: 1_000_000, usedBytes: 0))

        #expect(failures.isEmpty)
        #expect(try journal.isFileArchived("small.bin") == true)
    }

    /// Already at the ceiling from bytes previously stored (`usedBytes == limit`): even a tiny new file is
    /// refused. This is the real-world "5.9 GB of 1 GB" state — the vault is full, nothing more goes in.
    @Test func anAlreadyFullVaultRefusesEvenATinyFile() async throws {
        let (failures, journal, _) = try await runWithQuota(
            ["tiny.bin": Data(repeating: 0x42, count: 1_000)],
            quota: QuotaLimit(limitBytes: 1_000_000, usedBytes: 1_000_000))

        #expect(failures.count == 1)
        #expect(failures.first?.kind.isOverQuota == true)
        #expect(try journal.isFileArchived("tiny.bin") == false)
    }

    /// A running total, not a per-blob check against the same stale number: two blobs (files in separate
    /// folders bucket separately) with room for only ONE. Exactly one archives and one is refused — the
    /// engine adds each stored blob's bytes to `used` so the second is measured against the first, not against 0.
    @Test func theRunningTotalRefusesOnlyWhatNoLongerFits() async throws {
        let (failures, journal, vault) = try await runWithQuota(
            ["a/one.bin": Data(repeating: 0x11, count: 500_000),
             "b/two.bin": Data(repeating: 0x22, count: 500_000)],
            quota: QuotaLimit(limitBytes: 600_000, usedBytes: 0))   // fits one ~500 KB blob, not both

        let archived = [try journal.isFileArchived("a/one.bin"), try journal.isFileArchived("b/two.bin")]
        #expect(archived.filter { $0 }.count == 1)   // exactly one landed…
        #expect(failures.count == 1)                 // …and the other was refused
        #expect(failures.first?.kind.isOverQuota == true)
        #expect(vault.createdKeys.count == 1)        // only the blob that fit opened an upload
    }

    /// `nil` quota ⇒ don't enforce (dogfood mode, or an entitlement/usage the app couldn't resolve). A deposit
    /// far larger than any free tier archives untouched — failing open, exactly like the app-side gate.
    @Test func nilQuotaMeansNoEnforcement() async throws {
        let (failures, journal, _) = try await runWithQuota(
            ["huge.bin": Data(repeating: 0x42, count: 5_000_000)],
            quota: nil)

        #expect(failures.isEmpty)
        #expect(try journal.isFileArchived("huge.bin") == true)
    }

    /// **The stuck-pending fix, end-to-end through `DaemonService`.** A refused file was `upsert`ed (status
    /// `discovered`, which the UI paints as "uploading") but never archived — so without marking it `failed`
    /// its row sits pending FOREVER. This drives a real deposit through the daemon with a tiny quota and
    /// asserts the file lands in the journal as `.failed`, not `.discovered` — the row leaves "uploading".
    @Test func anOverQuotaDepositMarksTheFileFailedNotStuckPending() async throws {
        let fm = FileManager.default
        let root = fm.temporaryDirectory.appendingPathComponent("cs-quota-daemon-\(UUID().uuidString)")
        let drop = root.appendingPathComponent("drop")
        try fm.createDirectory(at: drop, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: root) }
        try Data(repeating: 0x42, count: 200_000).write(to: drop.appendingPathComponent("big.bin"))

        let sessions = SessionFactory(dataRoot: root.appendingPathComponent("data"), store: FakeVault(), canSelfThaw: false)
        let daemon = DaemonService(bus: EventBus(), sessions: sessions)
        let session = try sessions.make(.user(sub: "sub-1", identityId: "ca-central-1:1"))
        session.vaultKey.setMasterKey(SymmetricKey(size: .bits256))
        await daemon.beginSession(session)
        await daemon.setQuota(50_000)   // 200 KB deposit into a 50 KB ceiling → refused

        await daemon.deposit(paths: [drop.path], into: "")

        let row = try session.journal.listFiles().first { $0.relativePath.hasSuffix("big.bin") }
        #expect(row != nil)                          // it's IN the tree (listFiles returns it)…
        #expect(row?.status == .failed)              // …as `.failed`, not `.discovered` → the row leaves "uploading"
    }
}
