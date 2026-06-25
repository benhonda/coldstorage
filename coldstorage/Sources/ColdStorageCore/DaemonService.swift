import Foundation

/// The long-running service: turns the proven engine into `coldstored`. Owns the run loop, the live
/// source set (rebuilt each pass from the journal registry), pause/resume, and the command surface
/// the control socket dispatches to. Emits progress to the `EventBus`. The journal stays the SSOT —
/// this actor holds only transient run state (paused, running, the loop's wake latch).
public actor DaemonService {
    let engine: UploadEngine
    /// Drives get-a-file-back over the same store/keys as the upload engine. Idempotent + self-progressing:
    /// each `restore` command does the next step (request thaw → report progress → download + verify).
    let restoreEngine: RestoreEngine
    let journal: Journal
    let bus: EventBus
    let statusPath: String
    /// Platform sources that aren't path-based (Photos on macOS); folders come from the registry.
    let platformSources: [IngestSource]

    private var paused = false
    private var running = false
    // Blobs that failed *permanently* (config/logic — won't self-heal) this session. Skipped on the next
    // pass so we don't re-stage+re-attempt a doomed blob every interval. In-memory by design: a restart
    // retries once (maybe the operator fixed the config). Persisting it would need a journal schema change.
    private var permanentlyFailedBlobs: Set<String> = []
    // Wakeable sleep: `trigger()` either resumes a sleeping loop or, if none is sleeping yet, latches
    // so the next sleep returns immediately (coalesces bursts of triggers into one extra run).
    private var sleeper: CheckedContinuation<Void, Never>?
    private var triggerPending = false

    public init(engine: UploadEngine, restoreEngine: RestoreEngine, journal: Journal, bus: EventBus,
                statusPath: String, platformSources: [IngestSource] = []) {
        self.engine = engine; self.restoreEngine = restoreEngine; self.journal = journal; self.bus = bus
        self.statusPath = statusPath; self.platformSources = platformSources
    }

    // MARK: - run loop

    public func runOnce() async throws {
        try await performRun(source: try currentSource())
    }

    /// Archive an explicit set of dropped paths once — the ad-hoc **deposit** (drop-to-upload / "Choose
    /// files"). Distinct from `addSource`: it registers NO watched source, it just runs the proven pipeline
    /// over these paths, journaling them under `dir` (the browser folder dropped into) so they appear in
    /// `listFiles`. Non-throwing so the command can fire-and-forget it — any setup error surfaces as an
    /// `error` event; per-blob upload failures surface as `blobFailed` (same as a scheduled run).
    func deposit(paths: [String], into dir: String) async {
        let entries = paths.map { ExplicitPathsSource.Entry(url: URL(fileURLWithPath: $0), destDir: dir) }
        do { try await performRun(source: ExplicitPathsSource(entries: entries)) }
        catch { bus.publish(DaemonEvent("error", ["message": "deposit: \(error)"])) }
    }

    /// One pass of the pipeline over `source` — the shared core of a scheduled run and an ad-hoc deposit.
    /// Emits runStarted → fileArchived* → (blobFailed*) → runFinished; isolates per-blob failures and
    /// skip-lists permanent ones (so a doomed blob isn't re-attempted every pass).
    private func performRun(source: IngestSource) async throws {
        running = true
        bus.publish(DaemonEvent("runStarted"))
        let bus = self.bus
        let onFile: @Sendable (String, String) async -> Void = { id, blob in
            bus.publish(DaemonEvent("fileArchived", ["file": id, "blob": blob]))
        }
        // Per-file determinate upload progress (solo-blob large files only — see UploadEngine.archive).
        // Carries both id and path so the UI can match either a journal row (by id) or an optimistic
        // drop row (by path) — they diverge for Photos and for not-yet-archived deposits.
        let onProgress: @Sendable (UploadProgress) async -> Void = { p in
            bus.publish(DaemonEvent("uploadProgress", ["file": p.fileId, "path": p.path,
                                                       "bytes": "\(p.uploaded)", "totalBytes": "\(p.total)"]))
        }
        defer { running = false }
        let failures = try await engine.run(source: source,
                                            skipBlobIds: permanentlyFailedBlobs,
                                            onFileArchived: onFile, onProgress: onProgress)
        for f in failures {
            // Name the affected files by path (newline-joined) so a live watcher flips their rows + lists them
            // in the failures panel without waiting for the next listFiles read.
            bus.publish(DaemonEvent("blobFailed", ["blob": f.blobId,
                                                   "kind": f.kind.isPermanent ? "permanent" : "transient",
                                                   "message": f.kind.message,
                                                   "paths": f.files.map(\.path).joined(separator: "\n")]))
            if f.kind.isPermanent {
                permanentlyFailedBlobs.insert(f.blobId)
                // Persist the ⚠ as journal truth (survives refresh + restart). Best-effort: a write hiccup here
                // must not abort surfacing the remaining failures — the event already reported the fault.
                try? journal.markFilesFailed(f.files.map(\.id), error: f.kind.message)
            }
        }
        try writeStatus()
        let s = try journal.summary()
        bus.publish(DaemonEvent("runFinished", ["filesArchived": "\(s.archived)", "filesTotal": "\(s.total)",
                                                "blobsFailed": "\(failures.count)"]))
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
        do { return ControlResponseLine(id: req.id, result: try await handle(req.method, req.params ?? [:]), error: nil) }
        catch { return ControlResponseLine(id: req.id, result: nil, error: "\(error)") }
    }

    private struct StatusDTO: Encodable {
        let filesTotal, filesArchived, blobsVerified: Int
        let paused, running: Bool
        let permanentlyFailedBlobs: Int   // >0 ⇒ a blob is stuck on a config/logic fault the operator must fix
        let sources: [SourceDTO]
    }
    private struct SourceDTO: Encodable { let id, kind: String; let path: String? }
    /// One browsable file (the `listFiles` element). `status` is the raw journal `FileStatus` — the UI
    /// coarsens it to its own browse states (frozen/uploading/…); we expose what we actually know.
    private struct FileDTO: Encodable { let id, relativePath: String; let size: Int; let status: String; let blobId: String? }
    private struct AckDTO: Encodable { let ok: Bool }
    /// One idempotent restore step's outcome. `state` ∈ restored | thawRequested | thawInProgress —
    /// re-issue `restore` until it's `restored`. `out` is set only when bytes landed; `tier`/`typicalWait`
    /// only while thawing, so the UI can show the quoted wait.
    private struct RestoreDTO: Encodable { let file, state: String; let out, tier, typicalWait: String? }

    private func sourceDTOs() throws -> [SourceDTO] {
        try journal.listSources().map { SourceDTO(id: $0.id, kind: $0.kind.rawValue, path: $0.path) }
    }

    /// Map an idempotent restore step's outcome to its wire DTO, and push a matching progress event so a
    /// live `watch`er (the future UI) sees it without polling. Re-issue `restore` until `state == "restored"`.
    private func restoreResult(file: String, out: String, outcome: RestoreOutcome) -> RestoreDTO {
        switch outcome {
        case .restored:
            bus.publish(DaemonEvent("restoreCompleted", ["file": file, "out": out]))
            return RestoreDTO(file: file, state: "restored", out: out, tier: nil, typicalWait: nil)
        case .thawRequested(let tier):
            bus.publish(DaemonEvent("restoreRequested", ["file": file, "tier": tier.rawValue]))
            return RestoreDTO(file: file, state: "thawRequested", out: nil, tier: tier.rawValue, typicalWait: tier.typicalWait)
        case .thawInProgress:
            bus.publish(DaemonEvent("restoreInProgress", ["file": file]))
            return RestoreDTO(file: file, state: "thawInProgress", out: nil, tier: nil, typicalWait: nil)
        }
    }

    private func handle(_ method: String, _ p: [String: String]) async throws -> AnyEncodable {
        switch method {
        case "ping":
            return AnyEncodable(AckDTO(ok: true))
        case "getStatus":
            let s = try journal.summary()
            return AnyEncodable(StatusDTO(filesTotal: s.total, filesArchived: s.archived,
                                          blobsVerified: s.blobsVerified, paused: paused, running: running,
                                          permanentlyFailedBlobs: permanentlyFailedBlobs.count, sources: try sourceDTOs()))
        case "listSources":
            return AnyEncodable(try sourceDTOs())
        case "listFiles":
            // The browsable tree, straight from the journal — paths/sizes/status, no S3, no thaw.
            return AnyEncodable(try journal.listFiles().map {
                FileDTO(id: $0.id, relativePath: $0.relativePath, size: $0.size, status: $0.status.rawValue, blobId: $0.blobId)
            })
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
        case "restore":
            guard let file = p["file"] else { throw ColdStorageError.staging("restore requires params.file (the fileId)") }
            guard let out = p["out"] else { throw ColdStorageError.staging("restore requires params.out (output path)") }
            let tier = try RestoreTier.parse(p["tier"])
            // Reject a bad `days` rather than silently defaulting (same reason as tier — surface the typo).
            let days = try p["days"].map { raw -> Int in
                guard let d = Int(raw), d > 0 else { throw ColdStorageError.staging("bad days '\(raw)' (expected a positive integer)") }
                return d
            } ?? 7
            // One step toward getting the file back. Network I/O is awaited off the actor (reentrancy keeps
            // other commands responsive); a `.ready` download blocks only this call until bytes are verified.
            let outcome = try await restoreEngine.restore(fileId: file, to: URL(fileURLWithPath: out), tier: tier, days: days)
            return AnyEncodable(restoreResult(file: file, out: out, outcome: outcome))
        case "deposit":
            // Ad-hoc drop-to-upload: archive these paths once, under the browser folder `dest` ("" = root).
            // `src` is newline-joined absolute paths (one deposit covers a whole multi-file/folder drop).
            guard let raw = p["src"], !raw.isEmpty else { throw ColdStorageError.staging("deposit requires params.src (newline-joined absolute paths)") }
            let paths = raw.split(separator: "\n").map(String.init)
            let dest = p["dest"] ?? ""
            // Fire-and-forget: archiving can be slow, so don't block the reply. Progress + outcome flow as
            // runStarted/fileArchived/blobFailed/runFinished events (exactly like a scheduled run).
            Task { await self.deposit(paths: paths, into: dest) }
            return AnyEncodable(AckDTO(ok: true))
        case "movePath":
            // Reorganize: relocate the subtree at `from` → `to` (a file/folder move OR rename). A cheap
            // journal `relativePath` edit — no S3, no thaw, the blob never moves. `filesChanged` tells a live
            // watcher to re-read the tree.
            guard let from = p["from"] else { throw ColdStorageError.staging("movePath requires params.from (a vault-relative path)") }
            guard let to = p["to"] else { throw ColdStorageError.staging("movePath requires params.to (the new vault-relative path)") }
            try journal.movePath(from: from, to: to)
            bus.publish(DaemonEvent("filesChanged", ["moved": from, "to": to]))
            return AnyEncodable(AckDTO(ok: true))
        case "deletePath":
            // Tombstone the subtree at `path` (file or folder). The row + blob mapping are kept (bytes
            // reclaim is a deferred repack/GC); the file just drops out of `listFiles`.
            guard let path = p["path"] else { throw ColdStorageError.staging("deletePath requires params.path (a vault-relative path)") }
            try journal.deletePath(path)
            bus.publish(DaemonEvent("filesChanged", ["deleted": path]))
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
