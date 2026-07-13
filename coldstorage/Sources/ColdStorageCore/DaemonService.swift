import Foundation
import Crypto   // SymmetricKey — the vault commands (Phase 5b) decode/return the MasterKey

/// The long-running service: turns the proven engine into `coldstored`. Owns the run loop, the live
/// source set (rebuilt each pass from the journal registry, paused folders filtered out), per-source
/// pause/resume, and the command surface the control socket dispatches to. Emits progress to the
/// `EventBus`. The journal stays the SSOT — this actor holds only transient run state (running, the
/// loop's wake latch); pause is now persisted per-source in the journal, not a global actor flag.
public actor DaemonService {
    let bus: EventBus
    /// Platform sources that aren't path-based (Photos on macOS); folders come from the registry.
    let platformSources: [IngestSource]
    /// Resolves explicitly-picked Photos assets for `depositPhotos` (Mac PhotoKit); nil off macOS, where
    /// the command reports photos-unavailable. The seam that keeps PhotoKit out of this portable actor.
    let photoResolver: (any PhotoResolver)?
    /// Cognito credential/identity seam; nil only for an explicit local-dev daemon (`COLDSTORE_DEV_IDENTITY`).
    let cognitoAuth: CognitoAuth?
    /// Builds a ``UserSession`` for whoever signs in.
    let sessions: SessionFactory

    /// **The only per-user state this actor has.** Nil ⇒ signed out: there is no journal to read, no key to
    /// encrypt with, and no prefix to upload to. Constructed by `authenticate`, destroyed by
    /// `deauthenticate`. Everything a command needs about the current user hangs off this one optional, so
    /// a signed-out daemon cannot serve another account's data — not because every read path remembers to
    /// filter, but because there is nothing unscoped to read. See ``UserSession``.
    private var session: UserSession?

    private var running = false
    // Blobs that failed *permanently* (config/logic — won't self-heal) this session. Skipped on the next
    // pass so we don't re-stage+re-attempt a doomed blob every interval. In-memory by design: a restart
    // retries once (maybe the operator fixed the config). Persisting it would need a journal schema change.
    private var permanentlyFailedBlobs: Set<String> = []
    // Storage-quota usage cache: a fresh S3 listing (`usageBytes`) is cheap but not free, and `getStatus`
    // can be polled rapidly by the UI — a short TTL avoids a listing call on every poll while staying
    // current enough for a soft deposit gate. Per-VaultPrefix so a mid-session re-auth (different
    // identity) never serves a stale total for the wrong user.
    private var cachedUsage: (prefix: VaultPrefix, bytes: Int, at: Date)?
    private let usageCacheTTL: TimeInterval = 60
    // Wakeable sleep: `trigger()` either resumes a sleeping loop or, if none is sleeping yet, latches
    // so the next sleep returns immediately (coalesces bursts of triggers into one extra run).
    private var sleeper: CheckedContinuation<Void, Never>?
    private var triggerPending = false

    /// `initialSession` is set ONLY by an explicit local-dev daemon, which has no sign-in step and so needs
    /// a session up front. A real (Cognito) daemon starts signed out and gets its session from
    /// `authenticate`.
    public init(bus: EventBus, sessions: SessionFactory, platformSources: [IngestSource] = [],
                photoResolver: (any PhotoResolver)? = nil, cognitoAuth: CognitoAuth? = nil,
                initialSession: UserSession? = nil) {
        self.bus = bus; self.sessions = sessions; self.platformSources = platformSources
        self.photoResolver = photoResolver; self.cognitoAuth = cognitoAuth; self.session = initialSession
    }

    /// The signed-in user's state, or a clean refusal. Every command that touches user data goes through
    /// here — that's what makes "signed out ⇒ nothing to leak" a property of the code rather than a habit.
    private func requireSession(_ command: String) throws -> UserSession {
        guard let session else {
            throw ColdStorageError.staging("\(command): not signed in")
        }
        return session
    }

    /// Install `new` as the current session, tearing down whatever preceded it. This is the body of
    /// `authenticate` past the Cognito exchange, and `endSession` is the body of `deauthenticate` past the
    /// credential drop — factored out because the session LIFECYCLE is the thing that leaked, and it must be
    /// testable without a network round-trip to Cognito. See `SessionIsolationTests`.
    ///
    /// Everything derived from the previous user goes with them: the cached usage total (whose bytes belong
    /// to their prefix) and the permanently-failed blob set (whose ids mean nothing in another vault).
    func beginSession(_ new: UserSession) {
        session?.close()
        session = new
        cachedUsage = nil
        permanentlyFailedBlobs = []
        bus.publish(DaemonEvent("filesChanged", ["signedIn": new.identity.directoryName]))
    }

    /// Sign-out: release the session. The journal handle, the staging dir and the MasterKey all go with it.
    func endSession() {
        session?.close()
        session = nil
        cachedUsage = nil
        permanentlyFailedBlobs = []
        bus.publish(DaemonEvent("filesChanged", ["signedOut": "true"]))
    }

    /// The folders FSEvents should watch (active, non-paused) — same predicate the run loop scans by. Empty
    /// when signed out, so a signed-out daemon watches nothing.
    public func watchedFolderPaths() -> [String] {
        guard let session else { return [] }
        return ((try? session.journal.listSources()) ?? [])
            .compactMap { $0.kind == .folder && !$0.paused ? $0.path : nil }
    }

    // MARK: - run loop

    /// A signed-out daemon has no vault to sync, so a pass is a clean no-op rather than an error — the loop
    /// just idles until someone signs in.
    public func runOnce() async throws {
        guard let session else { return }
        try await performRun(session: session, source: try currentSource(session))
    }

    /// Archive an explicit set of dropped paths once — the ad-hoc **deposit** (drop-to-upload / "Choose
    /// files"). Distinct from `addSource`: it registers NO watched source, it just runs the proven pipeline
    /// over these paths, journaling them under `dir` (the browser folder dropped into) so they appear in
    /// `listFiles`. Non-throwing so the command can fire-and-forget it — any setup error surfaces as an
    /// `error` event; per-blob upload failures surface as `blobFailed` (same as a scheduled run).
    func deposit(paths: [String], into dir: String, conflicts: [String: ConflictPolicy] = [:]) async {
        do {
            let session = try requireSession("deposit")
            let entries = paths.map { ExplicitPathsSource.Entry(url: URL(fileURLWithPath: $0), destDir: dir) }
            let base = ExplicitPathsSource(entries: entries, exclude: excludeMatcher(session))
            try await performRun(session: session, source: resolveCollisions(session, base, conflicts))
        }
        catch { bus.publish(DaemonEvent("error", ["message": "deposit: \(error)"])) }
    }

    /// Archive an explicit set of picked Photos-library assets once — the photo analogue of `deposit`
    /// (file drop). Resolves each asset to its full-res original via the injected `PhotoResolver` (Mac
    /// PhotoKit) and runs the proven pipeline, journaling them under `dir` (the browser folder picked into)
    /// so they appear in `listFiles`. Photos are EXPLICIT-deposit only (product decision 2026-06-26) — we
    /// archive ONLY the picked assets, never the whole library. Non-throwing so the command can
    /// fire-and-forget; a missing resolver (off macOS) or setup error surfaces as an `error` event, while
    /// per-blob upload failures surface as `blobFailed` (same as any run).
    func depositPhotos(assetIds: [String], into dir: String, conflicts: [String: ConflictPolicy] = [:]) async {
        guard let resolver = photoResolver else {
            bus.publish(DaemonEvent("error", ["message": "depositPhotos: Photos ingest is unavailable on this platform"]))
            return
        }
        let base = PhotoDepositSource(resolver: resolver, assetIds: assetIds, destDir: dir)
        do {
            let session = try requireSession("depositPhotos")
            try await performRun(session: session, source: resolveCollisions(session, base, conflicts))
        }
        catch let e as ColdStorageError {
            // Photo-access / nothing-resolved are user-recoverable: surface the bare message (already a clean
            // sentence) plus a `code` the UI keys an action off (e.g. `photosAccessDenied` → "Open Photos
            // settings"). Other ColdStorageErrors fall through to the generic surface below.
            var data = ["message": e.description]
            switch e {
            case .photosAccess: data["code"] = "photosAccessDenied"
            case .photosNoneResolved: data["code"] = "photosNoneResolved"
            default: break
            }
            bus.publish(DaemonEvent("error", data))
        }
        catch { bus.publish(DaemonEvent("error", ["message": "depositPhotos: \(error)"])) }
    }

    /// Wrap a deposit source so the user's collision choices are honored (Keep Both / Replace / Skip). A
    /// no-op pass-through when there's nothing to resolve, so the common (no-collision) deposit is unchanged.
    /// Snapshots `livePaths()` once here — the "taken" set the keepBoth uniquifier avoids.
    private func resolveCollisions(_ session: UserSession, _ source: any IngestSource,
                                   _ conflicts: [String: ConflictPolicy]) -> any IngestSource {
        guard !conflicts.isEmpty else { return source }
        let existing = (try? session.journal.livePaths()) ?? []
        return CollisionResolvingSource(inner: source, existing: existing, conflicts: conflicts)
    }

    /// Parse the `conflicts` deposit param — a JSON object `{ "<vault/relativePath>": "keepBoth" }`. Unknown
    /// policy strings and malformed JSON are dropped (treated as "no resolution" → the item passes through),
    /// so a stale/garbled map can never abort a deposit.
    private func parseConflicts(_ raw: String?) -> [String: ConflictPolicy] {
        guard let raw, let data = raw.data(using: .utf8),
              let dict = try? JSONDecoder().decode([String: String].self, from: data) else { return [:] }
        return dict.compactMapValues { ConflictPolicy(rawValue: $0) }
    }

    /// One pass of the pipeline over `source` — the shared core of a scheduled run and an ad-hoc deposit.
    /// Emits runStarted → fileArchived* → (blobFailed*) → runFinished; isolates per-blob failures and
    /// skip-lists permanent ones (so a doomed blob isn't re-attempted every pass).
    private func performRun(session: UserSession, source: IngestSource) async throws {
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
        // Always close out a `runStarted` with a `runFinished`, even when the run THROWS before any blob
        // (e.g. a photo deposit that can't read the library). Otherwise the UI is stuck "syncing" forever and
        // the optimistic rows never reconcile. We re-throw so the caller still surfaces the cause as an
        // `error` event — runFinished just lets the UI leave the running state + re-read the tree.
        // The prefix comes from the SESSION — the signed-in user's own `blobs/<identity-id>`, the one the
        // IAM role's policy variable actually matches. There is no `?? "blobs"` fallback any more: no
        // session means no run at all, rather than a run that quietly lands in a shared namespace.
        let failures: [BlobFailure]
        do {
            failures = try await session.engine.run(source: source,
                                                    skipBlobIds: permanentlyFailedBlobs,
                                                    prefix: session.prefix,
                                                    onFileArchived: onFile, onProgress: onProgress)
        } catch {
            let s = try? session.journal.summary()
            bus.publish(DaemonEvent("runFinished", ["filesArchived": "\(s?.archived ?? 0)",
                                                    "filesTotal": "\(s?.total ?? 0)", "blobsFailed": "0"]))
            throw error
        }
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
                try? session.journal.markFilesFailed(f.files.map(\.id), error: f.kind.message)
            }
        }
        try writeStatus(session)
        let s = try session.journal.summary()
        bus.publish(DaemonEvent("runFinished", ["filesArchived": "\(s.archived)", "filesTotal": "\(s.total)",
                                                "blobsFailed": "\(failures.count)"]))
    }

    public func runForever(intervalSeconds: UInt64) async throws {
        // Seed status.json so the UI has something on first connect — only when signed in; a signed-out
        // daemon has no user whose status it could write.
        if let session { try writeStatus(session) }
        while !Task.isCancelled {
            // Pause is per-source now (paused folders are filtered out of `currentSource`), so the loop
            // always runs — a pass over zero unpaused folders is just a cheap no-op.
            do { try await runOnce() }
            catch { bus.publish(DaemonEvent("error", ["message": "\(error)"])) }   // surface, never crash the loop
            await wakeableSleep(seconds: intervalSeconds)
        }
    }

    /// The exclude patterns to scope a scan/deposit by, loaded fresh from the journal so an add/removeExclude
    /// over IPC takes effect on the very next run. Applied *inside* the directory walk (see `LocalDirSource`)
    /// so excluded files are never hashed and excluded folders never descended. (`try?`: a journal read
    /// hiccup must not abort the run — worst case is one pass without the latest filter.)
    private func excludeMatcher(_ session: UserSession) -> ExcludeMatcher {
        ExcludeMatcher(patterns: (try? session.journal.listExcludes()) ?? [])
    }

    /// Live source set = registered folders + platform sources (Photos). Rebuilt each run so
    /// add/remove via IPC takes effect on the next pass. Folder walks carry the current excludes; Photos
    /// don't (a photo library isn't a filesystem with gitignore-style junk).
    private func currentSource(_ session: UserSession) throws -> IngestSource {
        let matcher = excludeMatcher(session)
        let folders = try session.journal.listSources()
            .filter { $0.kind == .folder && !$0.paused }   // paused folders are skipped (still registered)
            .compactMap { row -> IngestSource? in
                guard let path = row.path else { return nil }
                let dir = LocalDirSource(root: URL(fileURLWithPath: path), exclude: matcher)
                // Mount the folder at its chosen destination in the drive (daemon-owned placement).
                return MountedSource(dir, mountPath: row.mountPath)
            }
        return MultiSource(folders + platformSources)
    }

    func writeStatus(_ session: UserSession) throws {
        let s = try session.journal.summary()
        let json = "{\"filesTotal\":\(s.total),\"filesArchived\":\(s.archived),\"blobsVerified\":\(s.blobsVerified)}\n"
        try json.write(toFile: session.statusPath, atomically: true, encoding: .utf8)
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
        /// Whether a user is signed in. When false, every other field is the empty/zero truth for a
        /// signed-out daemon — there IS no vault to report on. The UI keys its "signed out" state off the
        /// auth manager, but this makes the daemon's own answer explicit rather than inferred from zeros.
        let signedIn: Bool
        let filesTotal, filesArchived, blobsVerified: Int
        let running: Bool
        let permanentlyFailedBlobs: Int   // >0 ⇒ a blob is stuck on a config/logic fault the operator must fix
        let sources: [SourceDTO]
        /// Bytes currently stored in S3 under this user's prefix (storage-quota enforcement's usage
        /// figure — see `currentUsageBytes`). `nil` when signed out.
        let bytesStored: Int?
    }
    private struct SourceDTO: Encodable { let id, kind: String; let path: String?; let mountPath: String; let paused: Bool }
    /// One browsable file (the `listFiles` element). `status` is the raw journal `FileStatus` — the UI
    /// coarsens it to its own browse states (frozen/uploading/…); we expose what we actually know.
    /// `date` is the capture/creation time as Unix epoch SECONDS (nil when unknown). Epoch keeps the wire
    /// type trivial + lossless; the renderer owns ISO/display formatting (epoch × 1000 → JS `Date`).
    private struct FileDTO: Encodable { let id, relativePath: String; let size: Int; let status: String; let blobId: String?; let date: Int? }
    private struct AckDTO: Encodable { let ok: Bool }
    /// `authenticate`'s result: the Cognito identity id this daemon's uploads are now scoped under
    /// (`blobs/<identityId>`) — surfaced mainly for the UI/logs, since the daemon itself just reads
    /// `cognitoAuth.vaultPrefix` on the next run.
    private struct AuthDTO: Encodable { let ok: Bool; let identityId: String }
    /// `mintVault`'s result (signup): the key-blob to store server-side (base64 ciphertexts + salts), the
    /// one-time recovery code to show the user ONCE, and the freshly-minted MasterKey (base64) for the app
    /// to escrow in its per-device Keychain so day-to-day launches never re-prompt. All three cross only
    /// the local unix socket; the recovery code + MK never touch the network from here.
    private struct MintVaultDTO: Encodable {
        let ok: Bool
        let wrappedMKPassword, saltPassword, wrappedMKRecovery, saltRecovery: String
        let opsLimit, memLimit: Int
        let recoveryCode: String
        let masterKey: String
    }
    /// `unlockVaultWithRecoveryCode`'s result: the unlocked MasterKey (base64) for the app to escrow, so
    /// this new device won't need the recovery code again.
    private struct UnlockVaultDTO: Encodable { let ok: Bool; let masterKey: String }

    /// Storage-quota usage: bytes actually stored in S3 under the caller's own prefix (see
    /// `S3Store.usageBytes` for why this is S3, not the local journal). Cached `usageCacheTTL` seconds so a
    /// UI that polls `getStatus` frequently doesn't trigger a fresh S3 listing on every poll.
    private func currentUsageBytes(_ session: UserSession) async throws -> Int {
        let prefix = session.prefix
        if let cached = cachedUsage, cached.prefix == prefix, Date().timeIntervalSince(cached.at) < usageCacheTTL {
            return cached.bytes
        }
        let bytes = try await session.restoreEngine.store.usageBytes(prefix: prefix)
        cachedUsage = (prefix: prefix, bytes: bytes, at: Date())
        return bytes
    }

    /// Decode a base64 32-byte key param, or nil if absent. Throws on present-but-malformed (wrong length
    /// or bad base64) rather than silently truncating — a wrong-sized key would corrupt every blob.
    private func decodeKey(_ raw: String?) throws -> SymmetricKey? {
        guard let raw else { return nil }
        guard let data = Data(base64Encoded: raw), data.count == 32 else {
            throw ColdStorageError.staging("masterKey must be base64 of exactly 32 bytes")
        }
        return SymmetricKey(data: data)
    }

    /// Reconstruct a `KeyBlob` from the flat `[String:String]` control params (base64 ciphertexts/salts +
    /// integer tuning). The app passes the six fields straight through from the backend's key-blob JSON.
    private func keyBlob(from p: [String: String]) throws -> KeyBlob {
        func b64(_ key: String) throws -> Data {
            guard let raw = p[key], let d = Data(base64Encoded: raw) else {
                throw ColdStorageError.staging("keyBlob field '\(key)' missing or not base64")
            }
            return d
        }
        func int(_ key: String) throws -> Int {
            guard let raw = p[key], let v = Int(raw) else { throw ColdStorageError.staging("keyBlob field '\(key)' missing or not an integer") }
            return v
        }
        return KeyBlob(wrappedMKPassword: try b64("wrappedMKPassword"), saltPassword: try b64("saltPassword"),
                       wrappedMKRecovery: try b64("wrappedMKRecovery"), saltRecovery: try b64("saltRecovery"),
                       opsLimit: try int("opsLimit"), memLimit: try int("memLimit"))
    }
    /// One resolved target of a `previewDeposit` dry-run: the vault path the item WOULD land at, and whether
    /// a live row already sits there (a collision the UI prompts on).
    private struct DepositPreviewItemDTO: Encodable { let relativePath: String; let exists: Bool }
    /// One idempotent restore step's outcome. `state` ∈ restored | thawRequested | thawInProgress —
    /// re-issue `restore` until it's `restored`. `out` is set only when bytes landed; `tier`/`typicalWait`
    /// only while thawing, so the UI can show the quoted wait.
    /// `restorePlan`'s result: everything the account backend needs to price a restore. `blobKeys` is
    /// DEDUPED (one thaw per blob, however many files ride in it); `egressBytes` is the plaintext-span
    /// total that will actually come back.
    private struct RestorePlanDTO: Encodable { let blobKeys: [String]; let egressBytes: Int }

    /// `blobKey`/`egressBytes` are set only for `state == "authorizationRequired"` — they're what the app
    /// hands to the account backend's `POST /retrieval/quote` to price (and, once paid, trigger) the thaw.
    private struct RestoreDTO: Encodable {
        let file, state: String
        let out, tier, typicalWait: String?
        let blobKey: String?
        let egressBytes: Int?
    }

    private func sourceDTOs(_ session: UserSession) throws -> [SourceDTO] {
        try session.journal.listSources().map { SourceDTO(id: $0.id, kind: $0.kind.rawValue, path: $0.path, mountPath: $0.mountPath, paused: $0.paused) }
    }


    /// Map an idempotent restore step's outcome to its wire DTO, and push a matching progress event so a
    /// live `watch`er (the future UI) sees it without polling. Re-issue `restore` until `state == "restored"`.
    private func restoreResult(file: String, out: String, outcome: RestoreOutcome) -> RestoreDTO {
        switch outcome {
        case .restored:
            bus.publish(DaemonEvent("restoreCompleted", ["file": file, "out": out]))
            return RestoreDTO(file: file, state: "restored", out: out, tier: nil, typicalWait: nil, blobKey: nil, egressBytes: nil)
        case .thawRequested(let tier):
            bus.publish(DaemonEvent("restoreRequested", ["file": file, "tier": tier.rawValue]))
            return RestoreDTO(file: file, state: "thawRequested", out: nil, tier: tier.rawValue, typicalWait: tier.typicalWait,
                              blobKey: nil, egressBytes: nil)
        case .thawInProgress:
            bus.publish(DaemonEvent("restoreInProgress", ["file": file]))
            return RestoreDTO(file: file, state: "thawInProgress", out: nil, tier: nil, typicalWait: nil, blobKey: nil, egressBytes: nil)
        case .authorizationRequired(let blobKey, let egressBytes):
            // NOT an error — the normal first step of a paid restore on a multi-user daemon. The app takes
            // (blobKey, egressBytes) to the backend for a quote; once that's paid (or covered by the free
            // allowance) the backend thaws, and re-running `restore` picks up at `.thawInProgress`.
            bus.publish(DaemonEvent("restoreNeedsAuthorization",
                                    ["file": file, "blobKey": blobKey, "egressBytes": "\(egressBytes)"]))
            return RestoreDTO(file: file, state: "authorizationRequired", out: nil, tier: nil, typicalWait: nil,
                              blobKey: blobKey, egressBytes: egressBytes)
        }
    }

    private func handle(_ method: String, _ p: [String: String]) async throws -> AnyEncodable {
        switch method {
        case "ping":
            return AnyEncodable(AckDTO(ok: true))
        // ── Reads. Signed out ⇒ the EMPTY answer, not an error and not someone else's data. Empty is the
        // literal truth: a signed-out daemon has no vault. These four are the surface that leaked, and they
        // now physically cannot — there is no journal to reach without a session.
        case "getStatus":
            guard let session else {
                return AnyEncodable(StatusDTO(signedIn: false, filesTotal: 0, filesArchived: 0, blobsVerified: 0,
                                              running: false, permanentlyFailedBlobs: 0, sources: [], bytesStored: nil))
            }
            let s = try session.journal.summary()
            return AnyEncodable(StatusDTO(signedIn: true, filesTotal: s.total, filesArchived: s.archived,
                                          blobsVerified: s.blobsVerified, running: running,
                                          permanentlyFailedBlobs: permanentlyFailedBlobs.count,
                                          sources: try sourceDTOs(session),
                                          bytesStored: try await currentUsageBytes(session)))
        case "listSources":
            guard let session else { return AnyEncodable([SourceDTO]()) }
            return AnyEncodable(try sourceDTOs(session))
        case "listFiles":
            // The browsable tree, straight from THIS USER'S journal — paths/sizes/status, no S3, no thaw.
            guard let session else { return AnyEncodable([FileDTO]()) }
            return AnyEncodable(try session.journal.listFiles().map {
                FileDTO(id: $0.id, relativePath: $0.relativePath, size: $0.size, status: $0.status.rawValue, blobId: $0.blobId,
                        date: $0.createdAt)
            })
        case "listExcludes":
            guard let session else { return AnyEncodable([String]()) }
            return AnyEncodable(try session.journal.listExcludes())
        case "addSource":
            let session = try requireSession("addSource")
            guard let raw = p["path"] else { throw ColdStorageError.staging("addSource requires params.path") }
            let abs = URL(fileURLWithPath: raw).standardizedFileURL.path
            // Destination in the drive: where this folder's tree mounts. Default to the basename so a CLI
            // add (or any caller omitting it) still namespaces the source rather than dumping at root.
            // Trim leading/trailing slashes — mountPath is a vault-relative folder, never absolute.
            let rawMount = (p["mountPath"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let mount = rawMount.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            let mountPath = mount.isEmpty ? URL(fileURLWithPath: abs).lastPathComponent : mount
            try session.journal.addSource(SourceRow(id: abs, kind: .folder, path: abs, mountPath: mountPath))
            bus.publish(DaemonEvent("sourcesChanged", ["added": abs]))
            trigger()
            return AnyEncodable(AckDTO(ok: true))
        case "removeSource":
            let session = try requireSession("removeSource")
            guard let id = p["id"] else { throw ColdStorageError.staging("removeSource requires params.id") }
            try session.journal.removeSource(id)
            bus.publish(DaemonEvent("sourcesChanged", ["removed": id]))
            return AnyEncodable(AckDTO(ok: true))
        case "addExclude":
            let session = try requireSession("addExclude")
            // Register a gitignore-style pattern; it filters every later scan/deposit. Trim so a stray-space
            // paste doesn't create a pattern that matches nothing.
            let pattern = (p["pattern"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !pattern.isEmpty else { throw ColdStorageError.staging("addExclude requires a non-empty params.pattern") }
            try session.journal.addExclude(pattern)
            bus.publish(DaemonEvent("excludesChanged", ["added": pattern]))
            return AnyEncodable(AckDTO(ok: true))
        case "removeExclude":
            let session = try requireSession("removeExclude")
            guard let pattern = p["pattern"] else { throw ColdStorageError.staging("removeExclude requires params.pattern") }
            try session.journal.removeExclude(pattern)
            bus.publish(DaemonEvent("excludesChanged", ["removed": pattern]))
            return AnyEncodable(AckDTO(ok: true))
        case "restorePlan":
            let session = try requireSession("restorePlan")
            // What restoring these files would actually COST US to serve — the input to the account
            // backend's `POST /retrieval/quote` (root RETRIEVAL.md). The app calls this BEFORE it shows a
            // price, because a restore is priced on two things the renderer cannot know: the whole BLOB
            // objects that must be thawed (blobs are packed, so one photo can drag a 1 GiB blob with it)
            // and the bytes that actually come back.
            //
            // Blob keys are DEDUPED: several files usually share one blob, and that blob is thawed — and
            // billed — exactly once. Charging per-file here would overcharge the common case badly.
            guard let raw = p["files"], !raw.isEmpty else {
                throw ColdStorageError.staging("restorePlan requires params.files (newline-joined fileIds)")
            }
            var keys: [String] = []
            var seen = Set<String>()
            var egress = 0
            for fileId in raw.split(separator: "\n").map(String.init) {
                guard let f = try session.journal.fileMapping(fileId) else { throw ColdStorageError.staging("no archived file '\(fileId)'") }
                guard let key = try session.journal.blobS3Key(f.blobId) else { throw ColdStorageError.staging("no S3 key for blob \(f.blobId)") }
                egress += f.length
                if seen.insert(key).inserted { keys.append(key) }
            }
            return AnyEncodable(RestorePlanDTO(blobKeys: keys, egressBytes: egress))
        case "restore":
            let session = try requireSession("restore")
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
            let outcome = try await session.restoreEngine.restore(fileId: file, to: URL(fileURLWithPath: out), tier: tier, days: days)
            return AnyEncodable(restoreResult(file: file, out: out, outcome: outcome))
        case "deposit":
            _ = try requireSession("deposit")
            // Ad-hoc drop-to-upload: archive these paths once, under the browser folder `dest` ("" = root).
            // `src` is newline-joined absolute paths (one deposit covers a whole multi-file/folder drop).
            guard let raw = p["src"], !raw.isEmpty else { throw ColdStorageError.staging("deposit requires params.src (newline-joined absolute paths)") }
            let paths = raw.split(separator: "\n").map(String.init)
            let dest = p["dest"] ?? ""
            // Optional collision resolutions from the UI's Keep Both / Replace / Skip prompt (JSON map,
            // keyed by vault relativePath). Absent → no collisions to resolve, deposit as-is.
            let conflicts = parseConflicts(p["conflicts"])
            // Fire-and-forget: archiving can be slow, so don't block the reply. Progress + outcome flow as
            // runStarted/fileArchived/blobFailed/runFinished events (exactly like a scheduled run).
            Task { await self.deposit(paths: paths, into: dest, conflicts: conflicts) }
            return AnyEncodable(AckDTO(ok: true))
        case "depositPhotos":
            _ = try requireSession("depositPhotos")
            // Explicit photo deposit (the photo analogue of `deposit`): archive these PICKED Photos assets
            // once, under browser folder `dest` ("" = root). `assetIds` is newline-joined Photos
            // localIdentifiers. Only the picked assets are read — never the whole library (product decision
            // 2026-06-26). Fire-and-forget: progress/outcome flow as run*/fileArchived/blobFailed events.
            guard let raw = p["assetIds"], !raw.isEmpty else { throw ColdStorageError.staging("depositPhotos requires params.assetIds (newline-joined Photos localIdentifiers)") }
            let assetIds = raw.split(separator: "\n").map(String.init)
            let dest = p["dest"] ?? ""
            let conflicts = parseConflicts(p["conflicts"])
            Task { await self.depositPhotos(assetIds: assetIds, into: dest, conflicts: conflicts) }
            return AnyEncodable(AckDTO(ok: true))
        case "previewDeposit":
            let session = try requireSession("previewDeposit")
            // Dry-run a deposit's PLACEMENT (no upload): resolve the target paths the same way the real
            // deposit would (file paths via ExplicitPathsSource, picked photos via PhotoDepositSource — the
            // lazy `open` means no bytes stream), and report which already exist in the vault. The UI shows
            // the Keep Both / Replace / Skip prompt for the collisions, then re-issues deposit with a
            // `conflicts` map. Reusing the real source gives the EXACT resolved names — essential for photos,
            // whose filenames the UI can't know until the daemon resolves them.
            let dest = p["dest"] ?? ""
            let source: any IngestSource
            if let raw = p["src"], !raw.isEmpty {
                let entries = raw.split(separator: "\n").map { ExplicitPathsSource.Entry(url: URL(fileURLWithPath: String($0)), destDir: dest) }
                source = ExplicitPathsSource(entries: entries, exclude: excludeMatcher(session))
            } else if let raw = p["assetIds"], !raw.isEmpty {
                guard let resolver = photoResolver else { throw ColdStorageError.staging("previewDeposit: Photos ingest is unavailable on this platform") }
                source = PhotoDepositSource(resolver: resolver, assetIds: raw.split(separator: "\n").map(String.init), destDir: dest)
            } else {
                throw ColdStorageError.staging("previewDeposit requires params.src (paths) or params.assetIds")
            }
            let live = try session.journal.livePaths()
            let items = try await source.enumerate()
            return AnyEncodable(items.map { DepositPreviewItemDTO(relativePath: $0.relativePath, exists: live.contains($0.relativePath)) })
        case "movePath":
            let session = try requireSession("movePath")
            // Reorganize: relocate the subtree at `from` → `to` (a file/folder move OR rename). A cheap
            // journal `relativePath` edit — no S3, no thaw, the blob never moves. `filesChanged` tells a live
            // watcher to re-read the tree.
            guard let from = p["from"] else { throw ColdStorageError.staging("movePath requires params.from (a vault-relative path)") }
            guard let to = p["to"] else { throw ColdStorageError.staging("movePath requires params.to (the new vault-relative path)") }
            try session.journal.movePath(from: from, to: to)
            bus.publish(DaemonEvent("filesChanged", ["moved": from, "to": to]))
            return AnyEncodable(AckDTO(ok: true))
        case "createFolder":
            let session = try requireSession("createFolder")
            // Anchor an empty folder so it survives a reload (the tree is derived from file paths, so an
            // empty one otherwise has nothing to imply it). A path-only journal marker — no S3, no thaw.
            // Idempotent on the path. `filesChanged` tells a live watcher to re-read the tree.
            guard let path = p["path"], !path.isEmpty else { throw ColdStorageError.staging("createFolder requires params.path (a vault-relative folder path)") }
            try session.journal.createFolder(path: path)
            bus.publish(DaemonEvent("filesChanged", ["created": path]))
            return AnyEncodable(AckDTO(ok: true))
        case "deletePath":
            let session = try requireSession("deletePath")
            // Tombstone the subtree at `path` (file or folder). The row + blob mapping are kept (bytes
            // reclaim is a deferred repack/GC); the file just drops out of `listFiles`.
            guard let path = p["path"] else { throw ColdStorageError.staging("deletePath requires params.path (a vault-relative path)") }
            try session.journal.deletePath(path)
            bus.publish(DaemonEvent("filesChanged", ["deleted": path]))
            return AnyEncodable(AckDTO(ok: true))
        case "authenticate":
            // **Sign-in: where a session is born.** Exchange a Cognito User Pool ID token for real per-user
            // AWS credentials + the identity id our uploads are scoped under, then OPEN THAT USER'S STATE —
            // their journal, their staging dir, their key holder — and hold it as the one session.
            //
            // Idempotent across the app's hourly token refresh: the same `sub` re-authenticates the
            // credentials but KEEPS the existing session, because re-opening the journal would be pointless
            // churn and re-creating the key holder would drop an unlocked MasterKey and strand the user
            // mid-upload. A DIFFERENT `sub` is a different person: the old session is torn down (its key
            // cleared) before the new one is built, so nothing of theirs survives into this session.
            guard let auth = cognitoAuth else { throw ColdStorageError.staging("authenticate: this daemon has no Cognito identity pool configured") }
            guard let idToken = p["idToken"] else { throw ColdStorageError.staging("authenticate requires params.idToken") }
            let identityId = try await auth.authenticate(idToken: idToken)
            // Safe to read the token's claims un-verified ONLY here, and only because `auth.authenticate`
            // above just had Cognito accept this very token (see IDToken).
            let sub = try IDToken.sub(of: idToken)
            if let current = session, current.belongs(toSub: sub) {
                return AnyEncodable(AuthDTO(ok: true, identityId: identityId))
            }
            beginSession(try sessions.make(.user(sub: sub, identityId: identityId)))
            return AnyEncodable(AuthDTO(ok: true, identityId: identityId))
        case "deauthenticate":
            // **Sign-out: where a session dies.** Drop the STS creds immediately (rather than letting them
            // ride out the ~1h expiry) AND release the session — which closes the door on the journal, the
            // staging dir and the MasterKey in one move.
            //
            // This is the fix for the 2026-07-13 cross-account leak: sign-out used to drop only the
            // credentials and the key, leaving a machine-wide journal that the NEXT account then read as
            // its own. Now there is no such journal to leave behind.
            guard let auth = cognitoAuth else { throw ColdStorageError.staging("deauthenticate: this daemon has no Cognito identity pool configured") }
            await auth.deauthenticate()
            endSession()
            return AnyEncodable(AckDTO(ok: true))
        case "mintVault":
            // Signup (first ever sign-in on any device for this account): mint a fresh MasterKey + a
            // one-time recovery code, load the MK live (so this session can deposit immediately), and hand
            // the app the key-blob (to store server-side), the recovery code (to show once), and the MK (to
            // escrow per-device). Multi-user only — same gate as `authenticate`.
            let session = try requireSession("mintVault")
            let recoveryCode = try ZeroKnowledgeKeys.generateRecoveryCode()
            let (blob, mk) = try ZeroKnowledgeKeys.mintRecoveryOnly(recoveryCode: recoveryCode)
            session.vaultKey.setMasterKey(mk)
            return AnyEncodable(MintVaultDTO(
                ok: true,
                wrappedMKPassword: blob.wrappedMKPassword.base64EncodedString(),
                saltPassword: blob.saltPassword.base64EncodedString(),
                wrappedMKRecovery: blob.wrappedMKRecovery.base64EncodedString(),
                saltRecovery: blob.saltRecovery.base64EncodedString(),
                opsLimit: blob.opsLimit, memLimit: blob.memLimit,
                recoveryCode: recoveryCode,
                masterKey: mk.withUnsafeBytes { Data($0).base64EncodedString() }))
        case "unlockVault":
            // Day-to-day unlock from the app's per-device Keychain cache: the app already holds the MK, so
            // it just hands it back after a (re)connect. No crypto here — just load it.
            let session = try requireSession("unlockVault")
            guard let mk = try decodeKey(p["masterKey"]) else { throw ColdStorageError.staging("unlockVault requires params.masterKey (base64)") }
            session.vaultKey.setMasterKey(mk)
            return AnyEncodable(AckDTO(ok: true))
        case "unlockVaultWithRecoveryCode":
            // New device: the app fetched the key-blob from the backend and prompted for the recovery code.
            // Unwrap MK (a wrong code fails closed via the AES-GCM tag), load it live, and return it so the
            // app can escrow it — this device won't need the code again.
            let session = try requireSession("unlockVaultWithRecoveryCode")
            let blob = try keyBlob(from: p)
            guard let code = p["recoveryCode"] else { throw ColdStorageError.staging("unlockVaultWithRecoveryCode requires params.recoveryCode") }
            let mk = try ZeroKnowledgeKeys.unlockWithRecoveryCode(blob, recoveryCode: code)
            session.vaultKey.setMasterKey(mk)
            return AnyEncodable(UnlockVaultDTO(ok: true, masterKey: mk.withUnsafeBytes { Data($0).base64EncodedString() }))
        case "lockVault":
            // Sign-out: drop the MK. Subsequent deposits/restores fail `.vaultLocked` until the next unlock.
            //
            // Idempotent, and deliberately NOT session-gated: "ensure locked" is already true when there is
            // no session (no session ⇒ no key). The app fires `lockVault` and `deauthenticate` concurrently
            // on sign-out (ui/src/main/index.ts), so whichever lands second must not error — and if
            // `deauthenticate` wins the race it has already cleared the key via `endSession`.
            session?.vaultKey.clear()
            return AnyEncodable(AckDTO(ok: true))
        case "triggerNow":
            trigger()
            return AnyEncodable(AckDTO(ok: true))
        case "pauseSource":
            let session = try requireSession("pauseSource")
            // Per-folder pause: stop auto-syncing this one source (it stays registered). Persisted, so it
            // survives restart. Manual deposits are unaffected. `sourcesChanged` → the UI refetches.
            guard let id = p["id"] else { throw ColdStorageError.staging("pauseSource requires params.id") }
            try session.journal.setSourcePaused(id, true)
            bus.publish(DaemonEvent("sourcesChanged", ["paused": id]))
            return AnyEncodable(AckDTO(ok: true))
        case "resumeSource":
            let session = try requireSession("resumeSource")
            guard let id = p["id"] else { throw ColdStorageError.staging("resumeSource requires params.id") }
            try session.journal.setSourcePaused(id, false)
            bus.publish(DaemonEvent("sourcesChanged", ["resumed": id]))
            trigger()   // sync the just-resumed folder soon, don't wait for the next interval
            return AnyEncodable(AckDTO(ok: true))
        default:
            throw ColdStorageError.staging("unknown method: \(method)")
        }
    }
}
