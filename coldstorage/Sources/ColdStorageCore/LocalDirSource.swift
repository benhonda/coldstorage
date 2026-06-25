import Foundation
import Crypto

/// Container-friendly source: archives a directory tree so the whole pipeline runs on Linux/CI.
/// The macOS PhotoKitSource is the production counterpart implementing the same protocol.
public struct LocalDirSource: IngestSource {
    let root: URL
    /// Exclude patterns applied **during the walk** — so an excluded file is never hashed and an excluded
    /// directory (e.g. `node_modules`) is pruned whole, never descended. This is the right layer for it:
    /// excludes exist to avoid spending work on junk, and the walk is where that work (the SHA-256) starts.
    /// Default empty = no filtering, for tests/spikes that don't care.
    let exclude: ExcludeMatcher
    public init(root: URL, exclude: ExcludeMatcher = ExcludeMatcher(patterns: [])) {
        self.root = root; self.exclude = exclude
    }

    public func enumerate() async throws -> [IngestItem] {
        let fm = FileManager.default
        let keys: [URLResourceKey] = [.isRegularFileKey, .isDirectoryKey, .fileSizeKey, .contentModificationDateKey]
        guard let en = fm.enumerator(at: root, includingPropertiesForKeys: keys) else { return [] }
        var items: [IngestItem] = []
        // Drain via nextObject() rather than `for…in`: macOS Foundation marks NSEnumerator's
        // Sequence iterator unavailable in async contexts (Linux's swift-corelibs doesn't). Lazy, so
        // we don't materialize the whole tree as an array first.
        while let obj = en.nextObject() {
            guard let url = obj as? URL else { continue }
            let rel = url.path.replacingOccurrences(of: root.path + "/", with: "")
            let v = try url.resourceValues(forKeys: Set(keys))
            // Skip excluded paths before any hashing. Prune an excluded directory's whole subtree so we don't
            // even stat its children — the canonical win for a folder like node_modules.
            if !exclude.isEmpty, exclude.matches(rel) {
                if v.isDirectory == true { en.skipDescendants() }
                continue
            }
            guard v.isRegularFile == true else { continue }
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
