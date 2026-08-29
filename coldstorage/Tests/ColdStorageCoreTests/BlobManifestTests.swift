import Testing
import Foundation
import Crypto
@testable import ColdStorageCore

/// **A blob can be read back with nothing but its own bytes and the user's KEK.** This is the disaster-
/// recovery property: no journal, no daemon — the object's trailer names every file inside it, where its
/// bytes sit, what it hashed to, and its metadata, and carries the wrapped key to decrypt them.
@Suite struct BlobManifestTests {
    private func archive(_ files: [String: Data]) async throws -> (journal: Journal, vault: FakeVault, keys: LocalFileKEK, dir: URL) {
        let fm = FileManager.default
        let base = fm.temporaryDirectory.appendingPathComponent("cs-manifest-\(UUID().uuidString)")
        let root = base.appendingPathComponent("data")
        try fm.createDirectory(at: root, withIntermediateDirectories: true)
        for (name, bytes) in files { try bytes.write(to: root.appendingPathComponent(name)) }
        let journal = try Journal(path: base.appendingPathComponent("j.sqlite").path)
        let keys = LocalFileKEK(path: base.appendingPathComponent("kek.bin").path)
        let vault = FakeVault()
        let failures = try await UploadEngine(journal: journal, store: vault, keys: keys)
            .run(source: LocalDirSource(root: root), prefix: .dev)
        #expect(failures.isEmpty)
        return (journal, vault, keys, base)
    }

    @Test func trailerDescribesEveryFileAndAgreesWithTheJournal() async throws {
        let files = ["a.txt": Data("alpha".utf8), "b.bin": Data((0..<70_000).map { UInt8($0 & 0xff) }), "c.txt": Data("gamma".utf8)]
        let (journal, vault, keys, dir) = try await archive(files)
        defer { try? FileManager.default.removeItem(at: dir) }

        let rows = try journal.listFiles()
        let blobId = try #require(rows.first?.blobId)
        #expect(rows.allSatisfy { $0.blobId == blobId }, "small files batch into one blob")
        let key = try #require(try journal.blobS3Key(blobId))
        let object = try #require(vault.object(key))

        // Nothing but the bytes and the KEK.
        let manifest = try BlobTrailer.decode(object: object, kek: try keys.userKEK())
        #expect(manifest.version == BlobManifest.currentVersion)
        #expect(manifest.blobId == blobId)
        #expect(Set(manifest.files.map(\.relativePath)) == Set(files.keys))
        for entry in manifest.files {
            let span = try #require(try journal.fileMapping(entry.id))
            #expect(entry.offset == span.offset && entry.length == span.length && entry.firstFrame == span.firstFrame)
            #expect(entry.sha256 == span.plaintextSha256)
            #expect(entry.size == files[entry.relativePath]?.count)
            #expect(entry.metadata.modifiedAt != nil, "captured metadata rides in the manifest")
            #expect(entry.metadata == (try journal.fileMetadata(entry.id)))
        }
    }

    /// The trailer comes AFTER every file's frames, so restore's span arithmetic is untouched — and the
    /// files in a blob that carries a trailer still come back byte for byte.
    @Test func filesStillRestoreByteForByte() async throws {
        let files = ["one.txt": Data("one".utf8), "two.txt": Data(repeating: 7, count: 5_000_000)]
        let (journal, vault, keys, dir) = try await archive(files)
        defer { try? FileManager.default.removeItem(at: dir) }
        let restore = RestoreEngine(journal: journal, store: vault, keys: keys, canSelfThaw: true)
        for (name, original) in files {
            let dest = dir.appendingPathComponent("out-\(name)")
            _ = try await restore.restore(fileId: name, to: dest)
            #expect(try Data(contentsOf: dest) == original)
        }
    }

    /// The footer alone (no decryption) already says where the manifest is and carries the wrapped key —
    /// what a recovery tool reads from the tail of an object before it fetches anything else.
    @Test func footerParsesFromASuffixOfTheObject() async throws {
        let (journal, vault, keys, dir) = try await archive(["x.txt": Data("x".utf8)])
        defer { try? FileManager.default.removeItem(at: dir) }
        let blobId = try #require(try journal.listFiles().first?.blobId)
        let key = try #require(try journal.blobS3Key(blobId))
        let object = try #require(vault.object(key))
        let whole = try BlobTrailer.footer(of: object)
        let tail = object.suffix(min(object.count, 4096))
        let fromTail = try BlobTrailer.footer(of: Data(tail), objectSize: object.count)
        #expect(whole == fromTail)
        #expect(whole.manifestRange.upperBound < object.count)
        // The wrapped DEK in the footer IS the journal's.
        #expect(whole.wrappedDEK == (try journal.blobCrypto(blobId))?.wrappedDEK)
        _ = keys
    }

    @Test func aForeignObjectIsRefusedNotMisread() throws {
        #expect(throws: ColdStorageError.self) {
            _ = try BlobTrailer.footer(of: Data("not a coldstorage object at all".utf8))
        }
    }
}
