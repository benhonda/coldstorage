import Foundation

/// How a deposit resolves a name-collision with a file already in the target folder — the user's choice in
/// the Finder-style prompt. The daemon never decides this silently; absent an explicit policy a colliding
/// item is left as-is (`.replace` semantics: the upsert overwrites the existing row).
public enum ConflictPolicy: String, Sendable {
    /// Archive the incoming item under a fresh, non-colliding name (`IMG_8114 2.HEIC`) — keep both copies.
    case keepBoth
    /// Overwrite the existing file at that path with the incoming bytes (same path → same row, re-uploaded).
    case replace
    /// Don't deposit the incoming item at all.
    case skip
}

/// Decorates any `IngestSource` to apply per-path collision resolutions before the pipeline runs — the
/// daemon-side half of the deposit collision prompt. The UI previews collisions (`previewDeposit`), the user
/// picks a policy per colliding path, and this wraps the real deposit source so the chosen policy is honored
/// deterministically: `.skip` drops the item, `.replace` passes it through unchanged (the journal upsert
/// overwrites the existing row), `.keepBoth` re-keys it to a free name. Items with NO entry in `conflicts`
/// pass through untouched (they're new files, or weren't flagged as colliding). Works for file AND photo
/// deposits — both produce path-keyed `IngestItem`s — so collision handling lives in ONE place.
public struct CollisionResolvingSource: IngestSource {
    let inner: any IngestSource
    /// Vault paths already taken by a live row — `Journal.livePaths()` at deposit time. The uniquifier avoids
    /// these (plus the incoming batch's own surviving paths) so a `keepBoth` rename can't re-collide.
    let existing: Set<String>
    /// relativePath → chosen policy. Keys match `IngestItem.relativePath` exactly (same encoding the UI got
    /// back from `previewDeposit`).
    let conflicts: [String: ConflictPolicy]

    public init(inner: any IngestSource, existing: Set<String>, conflicts: [String: ConflictPolicy]) {
        self.inner = inner; self.existing = existing; self.conflicts = conflicts
    }

    public func enumerate() async throws -> [IngestItem] {
        let items = try await inner.enumerate()
        // Seed the "taken" set with everything a keepBoth rename must dodge: the live vault + every incoming
        // item that KEEPS its path this run (new files, and `.replace` overwrites). Skipped + keepBoth items
        // are excluded (the former vanish; the latter get a fresh name assigned below).
        var taken = existing
        for it in items where conflicts[it.relativePath] != .skip && conflicts[it.relativePath] != .keepBoth {
            taken.insert(it.relativePath)
        }
        var out: [IngestItem] = []
        out.reserveCapacity(items.count)
        for it in items {
            switch conflicts[it.relativePath] {
            case .skip:
                continue
            case .keepBoth:
                let rel = Self.uniquify(it.relativePath, taken: taken)
                taken.insert(rel)   // so two keepBoths in one batch don't collide with each other
                out.append(it.rekeyed(to: rel))
            case .replace, nil:
                out.append(it)
            }
        }
        return out
    }

    /// The first free vault path of the form `dir/stem N.ext` (Finder's convention: a space, then 2, 3, …)
    /// not present in `taken`. `path` itself is assumed taken (that's why we're uniquifying it).
    static func uniquify(_ path: String, taken: Set<String>) -> String {
        let parts = split(path)
        var n = 2
        while true {
            let candidate = ExplicitPathsSource.join(parts.dir, "\(parts.stem) \(n)\(parts.ext)")
            if !taken.contains(candidate) { return candidate }
            n += 1
        }
    }

    /// Split a vault path into (dir, stem, ext) where `dir` is the parent ("" at root), `stem` is the leaf
    /// without its extension, and `ext` includes the leading dot ("" when none). A leading-dot leaf
    /// (`.gitignore`) is treated as all-stem, no extension — matching Finder.
    static func split(_ path: String) -> (dir: String, stem: String, ext: String) {
        let dir: String, leaf: String
        if let slash = path.lastIndex(of: "/") {
            dir = String(path[path.startIndex..<slash]); leaf = String(path[path.index(after: slash)...])
        } else {
            dir = ""; leaf = path
        }
        if let dot = leaf.lastIndex(of: "."), dot != leaf.startIndex {
            return (dir, String(leaf[leaf.startIndex..<dot]), String(leaf[dot...]))
        }
        return (dir, leaf, "")
    }
}
