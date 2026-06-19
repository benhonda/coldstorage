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
