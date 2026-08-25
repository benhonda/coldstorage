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
    /// Patterns we'd *suggest* but that aren't active — the deposit-time prompt's candidate set
    /// (`ExcludeSuggestion.allPatterns`, minus whatever the user already excludes). Purely OBSERVATIONAL:
    /// a match here tags the entry and changes nothing about whether it's walked or archived, so a walk
    /// with suggestions produces exactly the same file set as one without. Default empty — a scheduled
    /// run has nobody to prompt, and only pays for this when the app is previewing a drop.
    let suggest: ExcludeMatcher
    public init(root: URL, exclude: ExcludeMatcher = ExcludeMatcher(patterns: []),
                suggest: ExcludeMatcher = ExcludeMatcher(patterns: [])) {
        self.root = root; self.exclude = exclude; self.suggest = suggest
    }

    /// One file the walk found — everything about it that costs no more than a `stat`.
    ///
    /// **The split exists because hashing is a full read of every byte.** `enumerate` needs the hash (it's the
    /// plan's key, and the blob id is derived from it), but the deposit PREVIEW only needs to answer "what
    /// would land where, and does it already exist" — and it used to get that by calling `enumerate`, which
    /// read the user's entire drop just to compute names it then threw away. On a 1000-file deposit that is a
    /// full pass over every byte before the UI can draw anything, and the UI gives up at 10 seconds.
    ///
    /// So: the walk (placement, cheap) is the shared SSOT; the hash is layered on by `enumerate` alone.
    /// Preview and archive can never disagree about where a file lands, because they walk the same code.
    public struct Entry: Sendable {
        public let url: URL
        public let relativePath: String
        public let size: Int
        public let modifiedAt: Date?
        /// The `suggest` pattern that WOULD have skipped this, if the user turned it on. nil normally.
        public let suggestedBy: String?
        init(url: URL, relativePath: String, size: Int, modifiedAt: Date?, suggestedBy: String? = nil) {
            self.url = url; self.relativePath = relativePath; self.size = size
            self.modifiedAt = modifiedAt; self.suggestedBy = suggestedBy
        }
    }

    /// Walk the tree, applying excludes, WITHOUT reading a single byte of content.
    public func walk() throws -> [Entry] {
        let fm = FileManager.default
        let keys: [URLResourceKey] = [.isRegularFileKey, .isDirectoryKey, .fileSizeKey, .contentModificationDateKey]
        // **`return []` used to live here, and it was the worst silent failure in the product.** A watched
        // folder that can't be read — external drive unmounted, folder deleted or renamed, macOS permission
        // revoked — makes `enumerator(at:)` return nil, and an empty result is INDISTINGUISHABLE from "the
        // folder is fine and has nothing new." So a backup that had stopped happening completed a clean run,
        // published `runFinished`, and reported "nothing new to archive" every five minutes indefinitely.
        // The one failure a backup product must never hide, hidden by one line.
        //
        // `fileExists` is checked separately from the enumerator so the message can say WHICH it was: a
        // vanished folder and an unreadable one need different things from the user (plug the drive back in
        // vs. grant access), and "couldn't read it" alone sends them looking in the wrong place.
        guard fm.fileExists(atPath: root.path) else {
            throw ColdStorageError.sourceUnreadable("\(root.path) isn't there — if it's on an external drive, plug it back in")
        }
        guard let en = fm.enumerator(at: root, includingPropertiesForKeys: keys) else {
            throw ColdStorageError.sourceUnreadable("can't read \(root.path) — check this Mac's permission for that folder")
        }
        var entries: [Entry] = []
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
            // A suggested-but-inactive pattern is NOT a prune — we keep walking so the prompt can quote a
            // real file count and byte total. Name patterns match on any path component, so a file deep
            // inside a `build/` folder is tagged by the same rule that tagged the folder; no propagation.
            entries.append(Entry(url: url, relativePath: rel, size: v.fileSize ?? 0,
                                 modifiedAt: v.contentModificationDate,
                                 suggestedBy: suggest.isEmpty ? nil : suggest.firstMatch(rel)))
        }
        return entries
    }

    public func enumerate() async throws -> [IngestItem] {
        try walk().map { e in
            IngestItem(
                id: e.relativePath, relativePath: e.relativePath, size: e.size,
                content: .sha256(try Self.sha256Hex(of: e.url)),   // the byte-reading pass — preview skips it
                createdAt: e.modifiedAt, isFavorite: false, sourcePath: e.url.path,
                open: { Self.stream(e.url) })
        }
    }

    /// **The `autoreleasepool` is load-bearing, and its absence is invisible on Linux.**
    ///
    /// On macOS, `FileHandle.read(upToCount:)` hands back Objective-C-backed buffers that are AUTORELEASED.
    /// In a tight loop with no pool to drain them they simply pile up until the enclosing task ends — Apple's
    /// own guidance is explicit that a FileHandle read loop "won't need an autoreleasepool on Linux but will
    /// on macOS". Hashing 2 GB of files left **841 MB resident before a single byte was uploaded**
    /// (2026-07-14), and every later measurement sat on top of that baseline.
    ///
    /// On Linux `autoreleasepool` is a straight passthrough — which is exactly why the Core's own memory
    /// tests, which run there, could never have caught this. Do not remove it because "the tests are green".
    static func sha256Hex(of url: URL) throws -> String {
        let h = try FileHandle(forReadingFrom: url); defer { try? h.close() }
        var hasher = SHA256()
        // Nothing escapes the pool: the chunk is consumed by the hasher inside it, so each iteration drains.
        while try autoreleasepool(invoking: {
            guard let c = try h.read(upToCount: ChunkReader.chunkSize), !c.isEmpty else { return false }
            hasher.update(data: c)
            return true
        }) {}
        return hasher.finalize().hex
    }

    /// Plaintext bytes, pulled on demand. A local file is a source we can read at OUR pace, so it needs no
    /// scratch copy and no buffer — see `ByteStreams.swift` for the unbounded-`AsyncThrowingStream` trap
    /// this deliberately avoids (it cost a 1k-file deposit on 2026-07-14).
    static func stream(_ url: URL) -> AsyncThrowingStream<Data, Error> { pullStream(of: url) }
}
