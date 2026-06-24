import Foundation

/// Ad-hoc ingest of explicitly chosen paths — the UI's drag-drop / "Choose files" **deposit**, NOT a
/// watched source. Each entry pairs an absolute path with the destination folder the user dropped it into
/// (a `relativePath` prefix; "" = the vault root). A dropped directory is walked (its contents placed
/// under `dest/<dirname>/…`); a dropped file is a single item under `dest/<filename>`. The resulting
/// `relativePath` is exactly what the browser tree shows — placement lives in the journal, never in S3
/// keys — so a deposit is just the proven pipeline run over these paths once, with no registry entry.
public struct ExplicitPathsSource: IngestSource {
    public struct Entry: Sendable {
        public let url: URL
        /// Destination folder (a vault-relative path; "" = root) the user dropped this into.
        public let destDir: String
        public init(url: URL, destDir: String) { self.url = url; self.destDir = destDir }
    }

    let entries: [Entry]
    public init(entries: [Entry]) { self.entries = entries }

    public func enumerate() async throws -> [IngestItem] {
        let fm = FileManager.default
        var items: [IngestItem] = []
        for e in entries {
            var isDir: ObjCBool = false
            guard fm.fileExists(atPath: e.url.path, isDirectory: &isDir) else { continue }  // skip a vanished drop
            if isDir.boolValue {
                // Reuse the proven directory walk; re-base each item under dest/<dirname>/… and re-key by
                // its new relativePath (the journal's stable id), keeping its captured byte stream + hash.
                let base = e.url.lastPathComponent
                for it in try await LocalDirSource(root: e.url).enumerate() {
                    let rel = Self.join(e.destDir, "\(base)/\(it.relativePath)")
                    items.append(IngestItem(id: rel, relativePath: rel, size: it.size, contentHash: it.contentHash,
                                            createdAt: it.createdAt, isFavorite: it.isFavorite,
                                            metadata: it.metadata, open: it.open))
                }
            } else {
                let rel = Self.join(e.destDir, e.url.lastPathComponent)
                let url = e.url
                let v = try? url.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey])
                items.append(IngestItem(
                    id: rel, relativePath: rel, size: v?.fileSize ?? 0,
                    contentHash: try LocalDirSource.sha256Hex(of: url),
                    createdAt: v?.contentModificationDate, isFavorite: false,
                    open: { LocalDirSource.stream(url) }))
            }
        }
        return items
    }

    /// Join a vault dir + a sub-path ("" + "a/b" → "a/b"; "x" + "a/b" → "x/a/b").
    static func join(_ dir: String, _ sub: String) -> String { dir.isEmpty ? sub : "\(dir)/\(sub)" }
}
