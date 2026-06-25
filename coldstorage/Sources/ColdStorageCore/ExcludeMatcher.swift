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
public struct ExcludeMatcher: Sendable {
    public let patterns: [String]
    public init(patterns: [String]) { self.patterns = patterns }
    public var isEmpty: Bool { patterns.isEmpty }

    /// True if `relativePath` should be skipped under any configured pattern.
    public func matches(_ relativePath: String) -> Bool {
        guard !patterns.isEmpty else { return false }
        let components = relativePath.split(separator: "/").map(String.init)
        for raw in patterns {
            // Tolerate a trailing slash (`caches/`) — folks paste them; semantically identical here.
            let p = raw.hasSuffix("/") ? String(raw.dropLast()) : raw
            guard !p.isEmpty else { continue }
            if p.contains("/") {
                if Self.glob(p, matches: relativePath) { return true }
            } else if components.contains(where: { Self.glob(p, matches: $0) }) {
                return true
            }
        }
        return false
    }

    /// Classic linear two-pointer glob with `*` backtracking; `?` matches exactly one character. `*` may
    /// span any characters — name patterns are tested per component (so `*` never needs to "stop at `/`"),
    /// and the rare path-anchored pattern is matched whole.
    static func glob(_ pattern: String, matches text: String) -> Bool {
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
