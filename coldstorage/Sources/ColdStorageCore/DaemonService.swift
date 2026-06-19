import Foundation

/// Turns the proven engine into a long-running service. v0: scan+archive the configured sources,
/// write a status.json the UI reads, loop on an interval. (Next increment: a unix-socket IPC for
/// live commands — add/remove source, trigger now, stream progress.)
public struct DaemonService: Sendable {
    let engine: UploadEngine
    let journal: Journal
    let statusPath: String

    public init(engine: UploadEngine, journal: Journal, statusPath: String) {
        self.engine = engine; self.journal = journal; self.statusPath = statusPath
    }

    public func runOnce() async throws {
        try await engine.run()
        try writeStatus()
    }

    public func runForever(intervalSeconds: UInt64) async throws {
        while !Task.isCancelled {
            try await runOnce()
            try await Task.sleep(for: .seconds(intervalSeconds))
        }
    }

    func writeStatus() throws {
        let s = try journal.summary()
        let json = "{\"filesTotal\":\(s.total),\"filesArchived\":\(s.archived),\"blobsVerified\":\(s.blobsVerified)}\n"
        try json.write(toFile: statusPath, atomically: true, encoding: .utf8)
    }
}
