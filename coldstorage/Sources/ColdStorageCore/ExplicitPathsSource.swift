import Foundation

/// One resolved target of a deposit dry-run: where the dropped/picked item WOULD land, plus its size in
/// bytes. The size is a free stat field from the placement walk (no bytes are read), and it lets the UI
/// run its pre-flight quota check against the EXACT incoming size — for a folder deposit as much as a loose
/// file — instead of guessing. `exists` (the collision flag) is added at the daemon seam against the journal.
public struct DepositPreviewPath: Sendable {
    public let relativePath: String
    public let size: Int
    /// The SUGGESTED (not active) exclude pattern that would have skipped this — see `ExcludeSuggestion`.
    /// It's what lets the app say "3.2 GB of this drop is build output — skip it?" *before* the upload,
    /// which is the only moment the user can still act for free. nil for everything we'd archive anyway.
    public let suggestedBy: String?
    public init(relativePath: String, size: Int, suggestedBy: String? = nil) {
        self.relativePath = relativePath; self.size = size; self.suggestedBy = suggestedBy
    }
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
    /// Suggested-but-inactive patterns, for `previewPaths` to tag with (never to filter by). Applied to
    /// dropped DIRECTORIES only, for the same reason `exclude` is: an explicitly dropped single file is a
    /// deliberate choice by hand, and second-guessing that with a prompt would be the app arguing with a
    /// user about a decision they just made one gesture ago.
    let suggest: ExcludeMatcher
    public init(entries: [Entry], exclude: ExcludeMatcher = ExcludeMatcher(patterns: []),
                suggest: ExcludeMatcher = ExcludeMatcher(patterns: [])) {
        self.entries = entries; self.exclude = exclude; self.suggest = suggest
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
                                            metadata: it.metadata, sourcePath: it.sourcePath, open: it.open))
                }
            } else {
                let rel = Self.join(e.destDir, e.url.lastPathComponent)
                let url = e.url
                let v = try? url.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey])
                let sha = try LocalDirSource.sha256Hex(of: url)
                items.append(IngestItem(
                    id: rel, relativePath: rel, size: v?.fileSize ?? 0,
                    content: .sha256(sha),
                    createdAt: v?.contentModificationDate, isFavorite: false, sourcePath: url.path,
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
                for entry in try LocalDirSource(root: e.url, exclude: exclude, suggest: suggest).walk() {
                    paths.append(DepositPreviewPath(relativePath: Self.join(e.destDir, "\(base)/\(entry.relativePath)"),
                                                    size: entry.size, suggestedBy: entry.suggestedBy))
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

/// The user's **Try again** on failed rows: re-ingest exactly those journal rows — same `id`, same
/// `relativePath` — from each row's own `sourcePath`: a filesystem path, or a `photos:<id>` asset the
/// resolver re-resolves. Not a re-drop: a re-drop places by `dest/<basename>`, which for a row that was
/// renamed, moved, or "Keep Both"-ed since would land a SECOND file next to the failed one instead of
/// finishing it. A row whose source has gone missing (or never had one) is skipped here — `retryFiles`
/// already refused to queue those, and the orphan sweep flips a skipped straggler back to `failed` with a
/// reason rather than leaving it "Uploading" for nobody.
public struct RetryFilesSource: IngestSource {
    let rows: [FileRow]
    /// How to re-resolve `photos:` sources, when this platform can (nil off macOS: those rows are skipped
    /// and the orphan sweep reports them, same as a vanished file).
    let photos: (resolver: any PhotoResolver, scratchDir: URL)?
    public init(rows: [FileRow], photos: (resolver: any PhotoResolver, scratchDir: URL)? = nil) {
        self.rows = rows; self.photos = photos
    }

    public func enumerate() async throws -> [IngestItem] {
        var items: [IngestItem] = []
        // Photos first, as one resolve (the resolver batches; a stale id is dropped, not fatal). Each
        // resolved asset is re-keyed onto ITS row — same id, same vault path — never re-placed by name.
        let photoRows = rows.compactMap { r in r.sourcePath.flatMap(IngestItem.photoAssetId).map { (asset: $0, row: r) } }
        if let photos, !photoRows.isEmpty {
            let byAsset = Dictionary(try await photos.resolver.resolve(assetIds: photoRows.map(\.asset), scratchDir: photos.scratchDir)
                                         .map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
            for (asset, row) in photoRows {
                guard let it = byAsset[asset] else { continue }
                items.append(IngestItem(id: row.id, relativePath: row.relativePath, size: it.size, content: it.content,
                                        createdAt: it.createdAt, isFavorite: it.isFavorite, metadata: it.metadata,
                                        sourcePath: row.sourcePath, open: it.open))
            }
        }
        for row in rows {
            guard let src = row.sourcePath, IngestItem.photoAssetId(fromSource: src) == nil else { continue }
            let url = URL(fileURLWithPath: src)
            var isDir: ObjCBool = false
            guard FileManager.default.fileExists(atPath: src, isDirectory: &isDir), !isDir.boolValue else { continue }
            let v = try? url.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey])
            let sha = try LocalDirSource.sha256Hex(of: url)
            items.append(IngestItem(
                id: row.id, relativePath: row.relativePath, size: v?.fileSize ?? 0,
                content: .sha256(sha),
                createdAt: v?.contentModificationDate, isFavorite: false, sourcePath: src,
                open: { LocalDirSource.stream(url) }))
        }
        return items
    }
}
