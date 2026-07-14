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
            return IngestItem(id: rel, relativePath: rel, size: it.size, contentHash: it.contentHash,
                              expectedSha256: it.expectedSha256,
                              createdAt: it.createdAt, isFavorite: it.isFavorite,
                              metadata: it.metadata, open: it.open)
        }
    }
}
