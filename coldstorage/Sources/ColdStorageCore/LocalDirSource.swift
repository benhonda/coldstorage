import Foundation
import Crypto

/// Container-friendly source: archives a directory tree so the whole pipeline runs on Linux/CI.
/// The macOS PhotoKitSource is the production counterpart implementing the same protocol.
public struct LocalDirSource: IngestSource {
    let root: URL
    public init(root: URL) { self.root = root }

    public func enumerate() async throws -> [IngestItem] {
        let fm = FileManager.default
        let keys: [URLResourceKey] = [.isRegularFileKey, .fileSizeKey, .contentModificationDateKey]
        guard let en = fm.enumerator(at: root, includingPropertiesForKeys: keys) else { return [] }
        var items: [IngestItem] = []
        // Drain via nextObject() rather than `for…in`: macOS Foundation marks NSEnumerator's
        // Sequence iterator unavailable in async contexts (Linux's swift-corelibs doesn't). Lazy, so
        // we don't materialize the whole tree as an array first.
        while let obj = en.nextObject() {
            guard let url = obj as? URL else { continue }
            let v = try url.resourceValues(forKeys: Set(keys))
            guard v.isRegularFile == true else { continue }
            let rel = url.path.replacingOccurrences(of: root.path + "/", with: "")
            let captured = url
            items.append(IngestItem(
                id: rel, relativePath: rel, size: v.fileSize ?? 0,
                contentHash: try Self.sha256Hex(of: url),
                createdAt: v.contentModificationDate, isFavorite: false,
                open: { Self.stream(captured) }))
        }
        return items
    }

    static func sha256Hex(of url: URL) throws -> String {
        let h = try FileHandle(forReadingFrom: url); defer { try? h.close() }
        var hasher = SHA256()
        while let c = try h.read(upToCount: 1 << 20), !c.isEmpty { hasher.update(data: c) }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    static func stream(_ url: URL) -> AsyncThrowingStream<Data, Error> {
        AsyncThrowingStream { cont in
            do {
                let h = try FileHandle(forReadingFrom: url)
                while let c = try h.read(upToCount: 1 << 20), !c.isEmpty { cont.yield(c) }
                try? h.close(); cont.finish()
            } catch { cont.finish(throwing: error) }
        }
    }
}
