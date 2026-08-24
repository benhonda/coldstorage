import Foundation

/// Decides whether a file's vault-relative path is excluded from archiving — the SSOT for our
/// gitignore-flavored exclude semantics, applied during the directory walk (see `LocalDirSource`). Pure +
/// `Sendable`, so it's unit-tested headless and safe to capture across a run.
///
/// Semantics, kept deliberately small (pillar: simple — surprise-free over fully gitignore-compatible):
///  - A pattern with **no `/`** is a *name* pattern: it matches when ANY path component matches it — so
///    `node_modules` excludes that folder (and everything under it) at any depth, and `*.tmp` excludes any
///    temp file. This is gitignore's "a bare name matches at every level" rule.
///  - A pattern that **contains `/`** is matched against the whole relative path (anchored, no leading `/`).
///  - Globs support `*` (any run of characters) and `?` (exactly one). No `[…]` classes, no `**` — none of
///    our defaults need them, and omitting them keeps the matcher legible and predictable.
///  - Matching is **case-insensitive**, because the filesystem it describes is. A default APFS/HFS+ volume
///    treats `Caches` and `caches` as the same directory, so a case-SENSITIVE matcher made every pattern a
///    spelling trap: our own shipped `caches` default never once fired on a real Mac, where the directory is
///    `Library/Caches`. A user typing `downloads` means the folder they can see in Finder.
public struct ExcludeMatcher: Sendable {
    /// The patterns as configured — what the user sees and what `firstMatch` reports back.
    public let patterns: [String]
    /// The same patterns normalized ONCE at construction: trailing slash trimmed, case-folded, empties
    /// dropped, paired with the raw form to report. The walk asks this matcher a question per file (times
    /// however many patterns), so anything constant that happens per-call is work multiplied by the size of
    /// someone's drop — and a matcher whose entire job is to avoid spending work shouldn't be the thing
    /// spending it. Folding here also means `glob` only ever lowercases the PATH.
    private let prepared: [(raw: String, folded: String, anchored: Bool)]

    public init(patterns: [String]) {
        self.patterns = patterns
        self.prepared = patterns.compactMap { raw in
            // Tolerate a trailing slash (`caches/`) — folks paste them; semantically identical here.
            let trimmed = raw.hasSuffix("/") ? String(raw.dropLast()) : raw
            guard !trimmed.isEmpty else { return nil }
            return (raw, trimmed.lowercased(), trimmed.contains("/"))
        }
    }
    public var isEmpty: Bool { patterns.isEmpty }

    /// True if `relativePath` should be skipped under any configured pattern.
    public func matches(_ relativePath: String) -> Bool { firstMatch(relativePath) != nil }

    /// WHICH pattern skipped it — `matches` with the reason kept. The deposit-time suggestion prompt needs
    /// to say *why* a file would be skipped ("14,000 files in node_modules"), and a bare `Bool` can't.
    /// Returns the first matching pattern in `patterns` order; nil when nothing matches.
    public func firstMatch(_ relativePath: String) -> String? {
        guard !prepared.isEmpty else { return nil }
        // Fold the path once for the whole pattern sweep, not once per pattern.
        let path = relativePath.lowercased()
        let components = path.split(separator: "/").map(String.init)
        for p in prepared {
            if p.anchored {
                if Self.folded(p.folded, matches: path) { return p.raw }
            } else if components.contains(where: { Self.folded(p.folded, matches: $0) }) {
                return p.raw
            }
        }
        return nil
    }

    /// Classic linear two-pointer glob with `*` backtracking; `?` matches exactly one character. `*` may
    /// span any characters — name patterns are tested per component (so `*` never needs to "stop at `/`"),
    /// and the rare path-anchored pattern is matched whole.
    /// Case-insensitive glob — the entry point callers outside `firstMatch` use. Folds both sides, then
    /// defers to {@link folded}, which is the hot path and assumes the folding already happened.
    static func glob(_ pattern: String, matches text: String) -> Bool {
        folded(pattern.lowercased(), matches: text.lowercased())
    }

    /// The matching primitive itself. **Both arguments must already be lowercased** — `firstMatch` folds
    /// its patterns at init and its path once per call, so neither is re-folded per comparison.
    static func folded(_ pattern: String, matches text: String) -> Bool {
        let pc = Array(pattern), tc = Array(text)
        var pi = 0, ti = 0, star = -1, mark = 0
        while ti < tc.count {
            if pi < pc.count, pc[pi] == "?" || pc[pi] == tc[ti] {
                pi += 1; ti += 1
            } else if pi < pc.count, pc[pi] == "*" {
                star = pi; mark = ti; pi += 1          // remember the `*` and where we tried to skip from
            } else if star != -1 {
                pi = star + 1; mark += 1; ti = mark    // backtrack: let the `*` absorb one more char
            } else {
                return false
            }
        }
        while pi < pc.count, pc[pi] == "*" { pi += 1 } // trailing `*`s match empty
        return pi == pc.count
    }
}
