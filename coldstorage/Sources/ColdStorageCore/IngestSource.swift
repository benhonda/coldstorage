import Foundation

/// The boundary between the portable core and the platform-specific sources.
/// macOS supplies PhotoKitSource + a folder watcher; Linux/CI uses LocalDirSource.
public protocol IngestSource: Sendable {
    func enumerate() async throws -> [IngestItem]
}

/// Combines several sources (folders + the Photos library) into one ingest list.
public struct MultiSource: IngestSource {
    let sources: [IngestSource]
    public init(_ sources: [IngestSource]) { self.sources = sources }
    public func enumerate() async throws -> [IngestItem] {
        var all: [IngestItem] = []
        for s in sources { all += try await s.enumerate() }
        return all
    }
}

/// Wraps ONE registered source so its scan outcome is **recorded** and its failure **isolated**.
///
/// Both halves are load-bearing, and they arrived together for a reason. Making `LocalDirSource.walk` throw
/// instead of silently returning `[]` is the honest fix, but on its own it would have been a downgrade:
/// `MultiSource` stops at the first throw, so a single unplugged drive would have stopped backing up every
/// OTHER folder too — trading a silent partial failure for a loud total one. So a failure here is reported
/// and then swallowed, and the run carries on with the folders that are fine.
///
/// The swallow is only defensible BECAUSE of the report. `onOutcome` is called on every pass either way —
/// nil for success, the error otherwise — and the daemon writes it to `sources.lastScanAt`/`sources.error`,
/// which is what lets the app say "this folder stopped backing up on the 3rd" instead of listing it as
/// though nothing were wrong. Returning `[]` after recording the reason is a different act from returning
/// `[]` and saying nothing, which is what this whole change is about.
public struct ScanReportingSource: IngestSource {
    let base: IngestSource
    /// Called once per `enumerate`, whatever happens: `nil` on success, the thrown error on failure.
    let onOutcome: @Sendable (Error?) -> Void
    public init(_ base: IngestSource, onOutcome: @escaping @Sendable (Error?) -> Void) {
        self.base = base; self.onOutcome = onOutcome
    }
    public func enumerate() async throws -> [IngestItem] {
        do {
            let items = try await base.enumerate()
            onOutcome(nil)
            return items
        } catch {
            onOutcome(error)
            return []
        }
    }
}

/// Re-bases a source's items under a vault-relative `mountPath` — the destination a watched folder lands
/// in My Files. Both `id` and `relativePath` are prefixed, so placement is the user's choice AND two
/// folders with same-named files no longer collide on the journal's `id`. Empty mountPath = identity
/// (root), but folders always carry a non-empty mount (the basename default), so that's only the
/// degenerate/test case. Mirrors `ExplicitPathsSource`'s dest-prefix re-keying for the watched path.
public struct MountedSource: IngestSource {
    let base: IngestSource
    let mountPath: String
    public init(_ base: IngestSource, mountPath: String) { self.base = base; self.mountPath = mountPath }
    public func enumerate() async throws -> [IngestItem] {
        guard !mountPath.isEmpty else { return try await base.enumerate() }
        return try await base.enumerate().map { it in
            let rel = "\(mountPath)/\(it.relativePath)"
            return IngestItem(id: rel, relativePath: rel, size: it.size, content: it.content,
                              createdAt: it.createdAt, isFavorite: it.isFavorite,
                              metadata: it.metadata, sourcePath: it.sourcePath, open: it.open)
        }
    }
}
