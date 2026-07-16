import Foundation

/// One resolved target of a deposit dry-run: where the dropped/picked item WOULD land, plus its size in
/// bytes. The size is a free stat field from the placement walk (no bytes are read), and it lets the UI
/// run its pre-flight quota check against the EXACT incoming size — for a folder deposit as much as a loose
/// file — instead of guessing. `exists` (the collision flag) is added at the daemon seam against the journal.
public struct DepositPreviewPath: Sendable {
    public let relativePath: String
    public let size: Int
    public init(relativePath: String, size: Int) { self.relativePath = relativePath; self.size = size }
}

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
    /// Applied only to **dropped directories** (their walk skips junk like node_modules) — NOT to an
    /// explicitly dropped single file, which the user chose by hand and we honor as-is.
    let exclude: ExcludeMatcher
    public init(entries: [Entry], exclude: ExcludeMatcher = ExcludeMatcher(patterns: [])) {
        self.entries = entries; self.exclude = exclude
    }

    public func enumerate() async throws -> [IngestItem] {
        let fm = FileManager.default
        var items: [IngestItem] = []
        for e in entries {
            var isDir: ObjCBool = false
            guard fm.fileExists(atPath: e.url.path, isDirectory: &isDir) else { continue }  // skip a vanished drop
            if isDir.boolValue {
                // Reuse the proven directory walk (with the same excludes — junk inside a dropped folder is
                // skipped before hashing); re-base each item under dest/<dirname>/… and re-key by its new
                // relativePath (the journal's stable id), keeping its captured byte stream + hash.
                let base = e.url.lastPathComponent
                for it in try await LocalDirSource(root: e.url, exclude: exclude).enumerate() {
                    let rel = Self.join(e.destDir, "\(base)/\(it.relativePath)")
                    items.append(IngestItem(id: rel, relativePath: rel, size: it.size, content: it.content,
                                            createdAt: it.createdAt, isFavorite: it.isFavorite,
                                            metadata: it.metadata, open: it.open))
                }
            } else {
                let rel = Self.join(e.destDir, e.url.lastPathComponent)
                let url = e.url
                let v = try? url.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey])
                let sha = try LocalDirSource.sha256Hex(of: url)
                items.append(IngestItem(
                    id: rel, relativePath: rel, size: v?.fileSize ?? 0,
                    content: .sha256(sha),
                    createdAt: v?.contentModificationDate, isFavorite: false,
                    open: { LocalDirSource.stream(url) }))
            }
        }
        return items
    }

    /// Where these drops WOULD land, without reading a byte of them.
    ///
    /// The collision preview only ever needed names. Getting them from `enumerate` meant SHA-256'ing the
    /// user's entire drop first — a full read of every byte before the UI could draw a single row, which on a
    /// 1000-file deposit blew straight through the UI's 10-second timeout and looked like a hang.
    ///
    /// It reuses the SAME placement arithmetic as `enumerate` (`LocalDirSource.walk` + `join`), so a preview
    /// can never disagree with the deposit it is previewing.
    public func previewPaths() async throws -> [DepositPreviewPath] {
        let fm = FileManager.default
        var paths: [DepositPreviewPath] = []
        for e in entries {
            var isDir: ObjCBool = false
            guard fm.fileExists(atPath: e.url.path, isDirectory: &isDir) else { continue }
            if isDir.boolValue {
                // The walk already stats `size` (a byte count, no content read) — carry it through so the
                // preview can price the deposit, rather than throwing it away and re-statting later.
                let base = e.url.lastPathComponent
                for entry in try LocalDirSource(root: e.url, exclude: exclude).walk() {
                    paths.append(DepositPreviewPath(relativePath: Self.join(e.destDir, "\(base)/\(entry.relativePath)"), size: entry.size))
                }
            } else {
                let size = (try? e.url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0
                paths.append(DepositPreviewPath(relativePath: Self.join(e.destDir, e.url.lastPathComponent), size: size))
            }
        }
        return paths
    }

    /// Join a vault dir + a sub-path ("" + "a/b" → "a/b"; "x" + "a/b" → "x/a/b").
    static func join(_ dir: String, _ sub: String) -> String { dir.isEmpty ? sub : "\(dir)/\(sub)" }
}
