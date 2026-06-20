import Foundation

/// The long-running service: turns the proven engine into `coldstored`. Owns the run loop, the live
/// source set (rebuilt each pass from the journal registry), pause/resume, and the command surface
/// the control socket dispatches to. Emits progress to the `EventBus`. The journal stays the SSOT —
/// this actor holds only transient run state (paused, running, the loop's wake latch).
public actor DaemonService {
    let engine: UploadEngine
    let journal: Journal
    let bus: EventBus
    let statusPath: String
    /// Platform sources that aren't path-based (Photos on macOS); folders come from the registry.
    let platformSources: [IngestSource]

    private var paused = false
    private var running = false
    // Wakeable sleep: `trigger()` either resumes a sleeping loop or, if none is sleeping yet, latches
    // so the next sleep returns immediately (coalesces bursts of triggers into one extra run).
    private var sleeper: CheckedContinuation<Void, Never>?
    private var triggerPending = false

    public init(engine: UploadEngine, journal: Journal, bus: EventBus,
                statusPath: String, platformSources: [IngestSource] = []) {
        self.engine = engine; self.journal = journal; self.bus = bus
        self.statusPath = statusPath; self.platformSources = platformSources
    }

    // MARK: - run loop

    public func runOnce() async throws {
        running = true
        bus.publish(DaemonEvent("runStarted"))
        let bus = self.bus
        let onFile: @Sendable (String, String) async -> Void = { id, blob in
            bus.publish(DaemonEvent("fileArchived", ["file": id, "blob": blob]))
        }
        defer { running = false }
        try await engine.run(source: try currentSource(), onFileArchived: onFile)
        try writeStatus()
        let s = try journal.summary()
        bus.publish(DaemonEvent("runFinished", ["filesArchived": "\(s.archived)", "filesTotal": "\(s.total)"]))
    }

    public func runForever(intervalSeconds: UInt64) async throws {
        try writeStatus()   // seed status.json so the UI has something on first connect
        while !Task.isCancelled {
            if !paused {
                do { try await runOnce() }
                catch { bus.publish(DaemonEvent("error", ["message": "\(error)"])) }   // surface, never crash the loop
            }
            await wakeableSleep(seconds: intervalSeconds)
        }
    }

    /// Live source set = registered folders + platform sources (Photos). Rebuilt each run so
    /// add/remove via IPC takes effect on the next pass.
    private func currentSource() throws -> IngestSource {
        let folders = try journal.listSources()
            .filter { $0.kind == .folder }
            .compactMap { $0.path }
            .map { LocalDirSource(root: URL(fileURLWithPath: $0)) as IngestSource }
        return MultiSource(folders + platformSources)
    }

    func writeStatus() throws {
        let s = try journal.summary()
        let json = "{\"filesTotal\":\(s.total),\"filesArchived\":\(s.archived),\"blobsVerified\":\(s.blobsVerified)}\n"
        try json.write(toFile: statusPath, atomically: true, encoding: .utf8)
    }

    // MARK: - wakeable sleep (interval, or sooner on trigger)

    /// Called by IPC commands / the FSEvents watcher to run sooner than the interval.
    public func trigger() {
        if let s = sleeper { sleeper = nil; s.resume() }
        else { triggerPending = true }
    }

    private func wake() { if let s = sleeper { sleeper = nil; s.resume() } }

    private func wakeableSleep(seconds: UInt64) async {
        if triggerPending { triggerPending = false; return }
        let timer = Task { [weak self] in
            try? await Task.sleep(for: .seconds(seconds))
            await self?.wake()
        }
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in self.sleeper = c }
        timer.cancel()
    }

    // MARK: - command surface (control socket)

    /// Map a request to a wire response — the closure handed to `ControlServer`.
    public func respond(to req: ControlRequest) async -> ControlResponseLine {
        do { return ControlResponseLine(id: req.id, result: try handle(req.method, req.params ?? [:]), error: nil) }
        catch { return ControlResponseLine(id: req.id, result: nil, error: "\(error)") }
    }

    private struct StatusDTO: Encodable {
        let filesTotal, filesArchived, blobsVerified: Int
        let paused, running: Bool
        let sources: [SourceDTO]
    }
    private struct SourceDTO: Encodable { let id, kind: String; let path: String? }
    private struct AckDTO: Encodable { let ok: Bool }

    private func sourceDTOs() throws -> [SourceDTO] {
        try journal.listSources().map { SourceDTO(id: $0.id, kind: $0.kind.rawValue, path: $0.path) }
    }

    private func handle(_ method: String, _ p: [String: String]) throws -> AnyEncodable {
        switch method {
        case "ping":
            return AnyEncodable(AckDTO(ok: true))
        case "getStatus":
            let s = try journal.summary()
            return AnyEncodable(StatusDTO(filesTotal: s.total, filesArchived: s.archived,
                                          blobsVerified: s.blobsVerified, paused: paused,
                                          running: running, sources: try sourceDTOs()))
        case "listSources":
            return AnyEncodable(try sourceDTOs())
        case "addSource":
            guard let raw = p["path"] else { throw ColdStorageError.staging("addSource requires params.path") }
            let abs = URL(fileURLWithPath: raw).standardizedFileURL.path
            try journal.addSource(SourceRow(id: abs, kind: .folder, path: abs))
            bus.publish(DaemonEvent("sourcesChanged", ["added": abs]))
            trigger()
            return AnyEncodable(AckDTO(ok: true))
        case "removeSource":
            guard let id = p["id"] else { throw ColdStorageError.staging("removeSource requires params.id") }
            try journal.removeSource(id)
            bus.publish(DaemonEvent("sourcesChanged", ["removed": id]))
            return AnyEncodable(AckDTO(ok: true))
        case "triggerNow":
            trigger()
            return AnyEncodable(AckDTO(ok: true))
        case "pause":
            paused = true; bus.publish(DaemonEvent("paused"))
            return AnyEncodable(AckDTO(ok: true))
        case "resume":
            paused = false; bus.publish(DaemonEvent("resumed")); trigger()
            return AnyEncodable(AckDTO(ok: true))
        default:
            throw ColdStorageError.staging("unknown method: \(method)")
        }
    }
}
