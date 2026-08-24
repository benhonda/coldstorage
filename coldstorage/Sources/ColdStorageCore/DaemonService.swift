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

    // **At most one pipeline runs at a time — the mutual exclusion the journal's integrity depends on.**
    // `performRun` awaits S3 for minutes, and a Swift actor is REENTRANT across `await`, so without this the
    // 300s scan timer AND every user deposit could each start a pipeline on top of one already in flight —
    // two passes planning the same blob, racing its upload id and part rows. A plain bool couldn't express
    // what's needed, because the two callers want opposite things when busy: a scheduled scan should SKIP
    // (the next tick re-scans anyway), a user deposit must WAIT then run (dropping the files someone just
    // dragged in would be a bug). `running` + a waiter queue gives both — see `withRunLock`.
    private var running = false
    private var runWaiters: [CheckedContinuation<Void, Never>] = []
    /// Guards `restorePass` against running twice at once. The actor suspends at every network await, so a
    /// pass kicked off by `requestRestore`/`resumeRestore` can interleave with the scheduled one — both
    /// would see the same row active and both would download it. That is a duplicated ranged GET: egress
    /// we pay for twice, and two writers racing on one destination path. Same shape as `running` above, and
    /// separate from it on purpose — a busy upload must never block a paid-for restore.
    private var restoring = false
    /// The run loop's beat, in seconds — the SSOT for it, so `coldstored` reads the default from here
    /// rather than restating a number the daemon is the owner of. `runForever` overwrites it with whatever
    /// it was actually started at; nothing else changes it.
    public static let defaultIntervalSeconds = 300
    private var intervalSeconds = DaemonService.defaultIntervalSeconds
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
    // The storage quota this account is allowed, pushed down by the app from its entitlement fetch
    // (`setQuota`). `nil` ⇒ DON'T enforce — dogfood mode, or an entitlement the app hasn't resolved — which
    // fails open exactly like the app-side gate. Every run (deposit, photo deposit, the periodic auto-run)
    // is checked against it in `UploadEngine`, so the ceiling holds on paths the UI never sees. Reset with
    // the session: a quota is one user's, and must never carry into the next.
    private var quotaBytes: Int?
    // Wakeable sleep: `trigger()` either resumes a sleeping loop or, if none is sleeping yet, latches
    // so the next sleep returns immediately (coalesces bursts of triggers into one extra run).
    private var sleeper: CheckedContinuation<Void, Never>?
    private var triggerPending = false

    /// The daemon always starts SIGNED OUT — it gets its session from `authenticate`, never at construction.
    public init(bus: EventBus, sessions: SessionFactory, platformSources: [IngestSource] = [],
                photoResolver: (any PhotoResolver)? = nil, cognitoAuth: CognitoAuth? = nil) {
        self.bus = bus; self.sessions = sessions; self.platformSources = platformSources
        self.photoResolver = photoResolver; self.cognitoAuth = cognitoAuth; self.session = nil
    }

    /// The signed-in user's state, or a clean refusal. Every command that touches user data goes through
    /// here — that's what makes "signed out ⇒ nothing to leak" a property of the code rather than a habit.
    private func requireSession(_ command: String) throws -> UserSession {
        guard let session else {
            throw ColdStorageError.invalidRequest("\(command): not signed in")
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
        quotaBytes = nil   // the app re-pushes this user's quota right after authenticate; never inherit the last user's
        bus.publish(DaemonEvent("filesChanged", ["signedIn": new.identity.directoryName]))
    }

    /// Set (or clear, with `nil`) the storage quota the engine enforces on every run. The wire handler
    /// (`setQuota`) is a thin parse over this; factored out so the enforcement can be tested without the
    /// control socket.
    func setQuota(_ bytes: Int?) { quotaBytes = bytes }

    /// Sign-out: release the session. The journal handle, the staging dir and the MasterKey all go with it.
    func endSession() {
        session?.close()
        session = nil
        cachedUsage = nil
        permanentlyFailedBlobs = []
        quotaBytes = nil
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

    /// Run `body` under the one-pipeline-at-a-time lock (see `running`). `skipIfBusy` distinguishes the two
    /// callers: a scheduled scan passes `true` (drop this tick — the next one re-scans anyway); a user
    /// deposit passes `false` (WAIT for the in-flight run, then go — never drop the dropped files). At most
    /// one `body` executes at a time, which is what stops two passes racing the shared journal.
    private func withRunLock(skipIfBusy: Bool, _ body: () async throws -> Void) async rethrows {
        if skipIfBusy {
            if running { return }
        } else {
            // Suspend until the current run finishes; loop because several waiters wake together and only one
            // may hold the lock. No `await` sits between the final `running` check and the set below, so the
            // acquire is atomic on the actor — no reentrancy gap.
            while running { await withCheckedContinuation { runWaiters.append($0) } }
        }
        running = true
        defer {
            running = false
            let waiters = runWaiters; runWaiters = []
            for w in waiters { w.resume() }   // wake all; they re-check `running` and one wins
        }
        try await body()
    }

    /// A signed-out daemon has no vault to sync, so a pass is a clean no-op rather than an error — the loop
    /// just idles until someone signs in. A scheduled pass is SKIPPED while a run is already in flight (the
    /// next tick re-scans and picks up whatever's left); it never stacks a second pipeline on the journal.
    public func runOnce() async throws {
        guard let session else { return }
        try await withRunLock(skipIfBusy: true) {
            try await performRun(session: session, source: try currentSource(session))
        }
    }

    /// Archive an explicit set of dropped paths once — the ad-hoc **deposit** (drop-to-upload / "Choose
    /// files"). Distinct from `addSource`: it registers NO watched source, it just runs the proven pipeline
    /// over these paths, journaling them under `dir` (the browser folder dropped into) so they appear in
    /// `listFiles`. Non-throwing so the command can fire-and-forget it — any setup error surfaces as an
    /// `error` event; per-blob upload failures surface as `blobFailed` (same as a scheduled run).
    /// `excludeExtra` are patterns to honor for this deposit ALONE — the user's "skip those, just this
    /// once" at the drop-time suggestion prompt. They're unioned with the registry for the run and then
    /// forgotten; nothing persists unless the app separately calls `addExclude`.
    func deposit(paths: [String], into dir: String, conflicts: [String: ConflictPolicy] = [:],
                 excludeExtra: [String] = []) async {
        do {
            let session = try requireSession("deposit")
            let entries = paths.map { ExplicitPathsSource.Entry(url: URL(fileURLWithPath: $0), destDir: dir) }
            let exclude = ExcludeMatcher(patterns: excludeMatcher(session).patterns + excludeExtra)
            let base = ExplicitPathsSource(entries: entries, exclude: exclude)
            // WAIT for any run in flight, then go — a deposit is the user's explicit action and must not be
            // dropped, but it also must not race a concurrent pass over the same journal.
            //
            // `explicitDeposit` is what lets this un-delete: dropping a file IS the ask, and a re-scan's
            // "I can still see it on disk" is not. The revive is scoped to the items this source actually
            // enumerates (`Journal.upsert`), NOT to the dropped path's whole former subtree — un-deleting by
            // prefix brought back every file that had ever lived under a re-dropped folder, on-disk or not.
            try await withRunLock(skipIfBusy: false) {
                try await performRun(session: session, source: resolveCollisions(session, base, conflicts),
                                     explicitDeposit: true)
            }
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
        do {
            // Session FIRST: it owns the scratch dir the resolver materializes pushed assets into, and that
            // dir is per-user (they're plaintext bytes) — so there is no source to build until we know who.
            let session = try requireSession("depositPhotos")
            let base = PhotoDepositSource(resolver: resolver, assetIds: assetIds,
                                          destDir: dir, scratchDir: session.scratchDir)
            try await withRunLock(skipIfBusy: false) {   // wait-then-run, like `deposit` — never dropped
                // Explicit, exactly like a file drop — so re-picking a photo you deleted brings it back.
                // It didn't before: this path never un-deleted anything, so the deposit silently no-op'd.
                try await performRun(session: session, source: resolveCollisions(session, base, conflicts),
                                     explicitDeposit: true)
            }
        }
        catch let e as ColdStorageError {
            // Photo-access / nothing-resolved are user-recoverable: surface the bare message (already a clean
            // sentence) plus a `code` the UI keys an action off (e.g. `photosAccessDenied` → "Open Photos
            // settings"). Other ColdStorageErrors fall through to the generic surface below.
            bus.publish(DaemonEvent("error", Self.errorEventData(e)))
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
    /// skip-lists permanent ones (so a doomed blob isn't re-attempted every pass). **Must be called through
    /// `withRunLock`** — it does not manage the run lock itself, so calling it bare would defeat the mutual
    /// exclusion. Every call site does.
    private func performRun(session: UserSession, source: IngestSource,
                            explicitDeposit: Bool = false) async throws {
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
        // Whole-run progress — the aggregate the UI turns into a bar, a byte readout, throughput and ETA.
        // Fires on every meaningful tick (run start with the denominators, each item as it starts, each part
        // as it ships, each file as it links), so a 1000-file batched deposit is no longer a black box. The
        // UI derives rate + ETA from the stream; the daemon only reports ground truth.
        let onRunProgress: @Sendable (RunProgress) async -> Void = { p in
            bus.publish(DaemonEvent("runProgress", [
                "filesTotal": "\(p.filesTotal)", "bytesTotal": "\(p.bytesTotal)",
                "filesArchived": "\(p.filesArchived)", "bytesUploaded": "\(p.bytesUploaded)",
                "currentPath": p.currentPath ?? "",
            ]))
        }
        // Always close out a `runStarted` with a `runFinished`, even when the run THROWS before any blob
        // (e.g. a photo deposit that can't read the library). Otherwise the UI is stuck "syncing" forever and
        // the optimistic rows never reconcile. We re-throw so the caller still surfaces the cause as an
        // `error` event — runFinished just lets the UI leave the running state + re-read the tree.
        // The prefix comes from the SESSION — the signed-in user's own `blobs/<identity-id>`, the one the
        // IAM role's policy variable actually matches. There is no `?? "blobs"` fallback any more: no
        // session means no run at all, rather than a run that quietly lands in a shared namespace.
        // Storage-quota ceiling for this run, resolved from the pushed `quotaBytes` + a fresh usage listing.
        // If either is missing — no quota pushed (dogfood), or the S3 usage read hiccups — we pass `nil` and
        // the engine doesn't enforce: failing open rather than blocking a backup over a number we couldn't
        // read mirrors the app-side gate. When set, the engine refuses any blob that would cross it.
        let quota: QuotaLimit?
        if let limit = quotaBytes, let usage = try? await currentUsageBytes(session) {
            quota = QuotaLimit(limitBytes: limit, usedBytes: usage)
        } else {
            quota = nil
        }
        let failures: [BlobFailure]
        // The engine runs in its own child Task so `cancelRun` has a handle to cancel. Cancellation is
        // cooperative and lands inside the engine (per frame / per blob), which turns the remaining work
        // into `.stopped` failures and RETURNS — it never throws out of here for a Stop. Cleared in `defer`
        // so a stale handle can't cancel a later run.
        let engine = session.engine
        let skip = permanentlyFailedBlobs
        let prefix = session.prefix
        let task = Task {
            try await engine.run(source: source, skipBlobIds: skip, prefix: prefix, quota: quota,
                                 explicitDeposit: explicitDeposit,
                                 onFileArchived: onFile, onProgress: onProgress, onRunProgress: onRunProgress)
        }
        runTask = task
        defer { runTask = nil }
        do {
            failures = try await task.value
        } catch {
            let s = try? session.journal.summary()
            bus.publish(DaemonEvent("runFinished", ["filesArchived": "\(s?.archived ?? 0)",
                                                    "filesTotal": "\(s?.total ?? 0)", "blobsFailed": "0"]))
            throw error
        }
        for f in failures {
            // Name the affected files by path (newline-joined) so a live watcher flips their rows + lists them
            // in the failures panel without waiting for the next listFiles read. NOT for a Stop: a 30 GB folder
            // stopped early is hundreds of blobs, and a flood of "failed" events for something the user chose
            // would bury the real faults in the UI's bounded failure log. The rows reconcile on the
            // `listFiles` re-read `runFinished` triggers; the count rides on `runFinished` itself.
            if f.kind.isStopped { continue }
            bus.publish(DaemonEvent("blobFailed", ["blob": f.blobId,
                                                   "kind": f.kind.wireKind,
                                                   "message": f.kind.message,
                                                   "paths": f.files.map(\.path).joined(separator: "\n")]))
            if f.kind.isPermanent {
                permanentlyFailedBlobs.insert(f.blobId)
                // Persist the ⚠ as journal truth (survives refresh + restart). Best-effort: a write hiccup here
                // must not abort surfacing the remaining failures — the event already reported the fault.
                try? session.journal.markFilesFailed(f.files.map(\.id), error: f.kind.message)
            } else if f.kind.isOverQuota || f.kind.isStopped {
                // Mark the files `failed` too, so their rows leave "uploading" — an over-quota file was upserted
                // (status `planned` = "uploading" in the UI) but never archived, and would otherwise sit
                // pending FOREVER after the refusal. But do NOT skip-list the blob: unlike a permanent fault,
                // this heals the moment there's room — a folder re-scan resets it to `planned` and retries.
                // A STOPPED blob is the same shape: not a fault, retried on the next pass / re-drop, and its
                // files would otherwise read "uploading" for an upload the user just ended.
                try? session.journal.markFilesFailed(f.files.map(\.id), error: f.kind.message)
            } else {
                // TRANSIENT — and until now the only case that left NOTHING behind. The two above were given
                // journal truth precisely because a file stuck reading "Uploading" forever is a lie; a
                // transient fault repeats, so it is the one most likely to produce that row, and it was the
                // one recorded nowhere but an ephemeral event. The file legitimately stays in flight (the
                // next pass retries — that is what transient means), so this records only WHY and WHEN,
                // leaving the status alone. `error` + `lastAttemptAt` together let the tree say "still
                // going, here's the snag" instead of a bare optimistic arrow.
                try? session.journal.recordFileFault(f.files.map(\.id), error: f.kind.message)
            }
        }
        try writeStatus(session)
        // A run just changed what's in S3, so the cached usage total is now stale — drop it. The next read
        // (a getStatus poll, or the NEXT run's quota ceiling) then does a fresh listing rather than enforcing
        // against, or showing, a pre-deposit number for up to the cache TTL.
        cachedUsage = nil
        let s = try session.journal.summary()
        // `blobsFailed` counts FAULTS; a Stop is reported separately so the UI can say "stopped" rather than
        // "N couldn't upload" about work the user ended on purpose.
        let stopped = failures.filter(\.kind.isStopped)
        bus.publish(DaemonEvent("runFinished", ["filesArchived": "\(s.archived)", "filesTotal": "\(s.total)",
                                                "blobsFailed": "\(failures.count - stopped.count)",
                                                "filesStopped": "\(stopped.reduce(0) { $0 + $1.files.count })"]))
    }

    /// The engine Task of the run in flight, if any — what `cancelRun` cancels. Set/cleared by `performRun`.
    private var runTask: Task<[BlobFailure], Error>?

    /// Stop the run in flight. Cooperative: the engine notices within a frame, cancels its in-flight part
    /// PUTs, reports every unfinished blob `.stopped`, and `performRun` closes out with `runFinished` as
    /// usual — so the UI's run state, the tree, and the counts all reconcile through the one existing path.
    /// Nothing already landed is undone: completed blobs are archived, and a half-uploaded blob keeps its
    /// multipart upload on S3 for a later run to resume part-for-part. Returns whether there was a run to stop.
    public func cancelRun() -> Bool {
        guard let task = runTask else { return false }
        task.cancel()
        return true
    }

    public func runForever(intervalSeconds: UInt64) async throws {
        // Recorded so `restoreRowDTOs` can derive `staleAfterSeconds` from the REAL cadence — the app must
        // not have to guess at (or hardcode) how often we promise to look at a transfer.
        self.intervalSeconds = Int(intervalSeconds)
        // Seed status.json so the UI has something on first connect — only when signed in; a signed-out
        // daemon has no user whose status it could write.
        if let session { try writeStatus(session) }
        while !Task.isCancelled {
            // Pause is per-source now (paused folders are filtered out of `currentSource`), so the loop
            // always runs — a pass over zero unpaused folders is just a cheap no-op.
            do { try await runOnce() }
            catch { bus.publish(DaemonEvent("error", ["message": "\(error)"])) }   // surface, never crash the loop
            // Push in-flight transfers along on the same beat. Deliberately OUTSIDE the upload pass and
            // after it: a stuck or busy upload run must never be the reason a paid-for restore stops
            // progressing. Non-throwing by construction — it records faults on the row, never here.
            if let session { await restorePass(session) }
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

    /// The suggested patterns this user has NOT already excluded — the candidate set a deposit preview tags
    /// with. Subtracting the active list is what stops the prompt re-offering a pack the user turned on
    /// (or, just as importantly, one they deliberately turned back OFF, pattern by pattern).
    private func suggestionMatcher(_ session: UserSession) -> ExcludeMatcher {
        let active = Set((try? session.journal.listExcludes()) ?? [])
        return ExcludeMatcher(patterns: ExcludeSuggestion.allPatterns.filter { !active.contains($0) })
    }

    /// Live source set = registered folders + platform sources (Photos). Rebuilt each run so
    /// add/remove via IPC takes effect on the next pass. Folder walks carry the current excludes; Photos
    /// don't (a photo library isn't a filesystem with gitignore-style junk).
    /// The `error` event payload for a user-recoverable fault: the bare message plus a `code` the UI keys an
    /// action off (`photosAccessDenied` → "Open Photos settings"). Shared by the explicit photo deposit and
    /// the scheduled scan, because the same denial reaching the user through two paths must not arrive
    /// actionable through one and bare through the other.
    static func errorEventData(_ error: Error) -> [String: String] {
        var data = ["message": "\(error)"]
        switch error {
        case ColdStorageError.photosAccess: data["code"] = "photosAccessDenied"
        case ColdStorageError.photosNoneResolved: data["code"] = "photosNoneResolved"
        default: break
        }
        return data
    }

    private func currentSource(_ session: UserSession) throws -> IngestSource {
        let matcher = excludeMatcher(session)
        // Captured so the per-source callback can write without hopping back onto the actor — `Journal`
        // carries its own lock, exactly like the restore path's `willDownload`/`onProgress` callbacks.
        let journal = session.journal
        let bus = self.bus
        let folders = try session.journal.listSources()
            .filter { $0.kind == .folder && !$0.paused }   // paused folders are skipped (still registered)
            .compactMap { row -> IngestSource? in
                guard let path = row.path else { return nil }
                let dir = LocalDirSource(root: URL(fileURLWithPath: path), exclude: matcher)
                // Mount the folder at its chosen destination in the drive (daemon-owned placement).
                let mounted = MountedSource(dir, mountPath: row.mountPath)
                // Each folder reports its OWN outcome and can't take the others down with it. Before this,
                // `LocalDirSource` returned an empty list for a folder it couldn't read, so a backup that had
                // stopped looked identical to one with nothing new — and there was no per-source state
                // anywhere to say otherwise. See `ScanReportingSource` for why isolate-and-report had to
                // land together rather than just letting the walk throw.
                let id = row.id
                return ScanReportingSource(mounted) { error in
                    // Announce on a CHANGE — broke or healed — so a live app updates the folder's row on the
                    // pass it happens. Publishing every pass would be noise; publishing only on failure (the
                    // first cut) left a red "Can't reach it" sitting there after the drive was plugged back
                    // in, because the fault cleared in the journal and nothing told anyone.
                    let changed = (try? journal.markSourceScanned(id, error: error.map { "\($0)" })) ?? false
                    if changed { bus.publish(DaemonEvent("sourcesChanged", [:])) }
                }
            }
        // Platform sources (the Photos library on macOS) get the SAME isolation. They have no journal row to
        // record against — nothing ever creates a `.photos` source — but the half that matters here is that a
        // denied Photos permission was aborting `MultiSource.enumerate()` and therefore the WHOLE run, so one
        // revoked toggle stopped every watched folder from backing up. That is the exact failure mode the
        // wrapper exists to prevent, and leaving it in place for Photos while fixing it for folders would
        // have been arbitrary. The fault still reaches the user — now WITH its actionable `code`, where the
        // aborting path published a bare message.
        let platform = platformSources.map { source in
            ScanReportingSource(source) { error in
                if let error { bus.publish(DaemonEvent("error", Self.errorEventData(error))) }
            }
        }
        return MultiSource(folders + platform)
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
        /// How long a piece of in-flight work may go untouched before the app should stop calling it live —
        /// derived from THIS daemon's real loop cadence (`RestoreRow.staleAfter`).
        ///
        /// Daemon-wide, so it lives on the daemon's snapshot. It briefly rode on each restore row instead,
        /// which read fine until the file tree needed the same number and there was no restore row to take
        /// it from — a per-row home for a per-daemon fact. One question ("how long is too quiet?"), one
        /// answer, from the only party that knows the beat (`COLDSTORE_INTERVAL` makes it configurable).
        let staleAfterSeconds: Int
    }
    /// One registered ingest source. `lastScanAt`/`error` are its honesty pair — when we last scanned it and
    /// what went wrong — so a watched folder that has stopped backing up can say so where it's listed,
    /// instead of appearing identical to a working one.
    ///
    /// Explicit `encode(to:)` for the reason given on `FileDTO`: a synthesized encoder omits nils, while
    /// `protocol.ts` declares these `T | null`.
    private struct SourceDTO: Encodable {
        let id, kind: String
        let path: String?
        let mountPath: String
        let paused: Bool
        let lastScanAt: Int?
        let error: String?

        enum CodingKeys: String, CodingKey { case id, kind, path, mountPath, paused, lastScanAt, error }

        func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(id, forKey: .id)
            try c.encode(kind, forKey: .kind)
            try c.encode(path, forKey: .path)                // `encode`, not `encodeIfPresent` — emits null
            try c.encode(mountPath, forKey: .mountPath)
            try c.encode(paused, forKey: .paused)
            try c.encode(lastScanAt, forKey: .lastScanAt)
            try c.encode(error, forKey: .error)
        }
    }
    /// One browsable file (the `listFiles` element). `status` is the raw journal `FileStatus` — the UI
    /// coarsens it to its own browse states (frozen/uploading/…); we expose what we actually know.
    /// `date` is the capture/creation time as Unix epoch SECONDS (nil when unknown). Epoch keeps the wire
    /// type trivial + lossless; the renderer owns ISO/display formatting (epoch × 1000 → JS `Date`).
    /// One row of the browsable tree.
    ///
    /// `lastAttemptAt` + `error` are the file's honesty pair, the upload twin of what `RestoreRow` carries:
    /// when the upload path last tried, and what went wrong if anything. Without them the tree renders
    /// `planned` as "Uploading" with no expiry and no reason — and `error` had been sitting in the journal
    /// unread the whole time, so even a permanently failed file showed a ⚠ that couldn't say why.
    ///
    /// Hand-written `encode(to:)` for the reason spelled out on `RestoreRowDTO`: the synthesized encoder
    /// uses `encodeIfPresent`, so every nil here would be OMITTED from the JSON, while `protocol.ts`
    /// declares these as `T | null` — a promise that the key is always present. That drift already existed
    /// on `blobId`/`date` (latent: the readers happen to use `!=`, which tolerates `undefined`); adding two
    /// more optionals to a contract nobody was keeping is how latent becomes real.
    private struct FileDTO: Encodable {
        let id, relativePath: String
        let size: Int
        let status: String
        let blobId: String?
        let date: Int?
        let lastAttemptAt: Int?
        let error: String?

        enum CodingKeys: String, CodingKey {
            case id, relativePath, size, status, blobId, date, lastAttemptAt, error
        }

        func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(id, forKey: .id)
            try c.encode(relativePath, forKey: .relativePath)
            try c.encode(size, forKey: .size)
            try c.encode(status, forKey: .status)
            try c.encode(blobId, forKey: .blobId)              // `encode`, not `encodeIfPresent` — emits null
            try c.encode(date, forKey: .date)
            try c.encode(lastAttemptAt, forKey: .lastAttemptAt)
            try c.encode(error, forKey: .error)
        }
    }
    private struct AckDTO: Encodable { let ok: Bool }

    /// The answer to "will this come back?", so the client can say so instead of letting the user find out.
    /// `isWatched` = the file is still on disk inside a watched folder, so the folder would keep re-finding
    /// it; `ignored` = we also added the exclude, so it won't.
    private struct DeleteResultDTO: Encodable { let ok: Bool; let isWatched: Bool; let ignored: Bool }

    /// Answer to `pathIsWatched` — "would a scan find this again tomorrow?"
    private struct WatchedDTO: Encodable { let isWatched: Bool }

    /// Is `path` (vault-relative) still present on disk inside a live watched folder?
    ///
    /// This is the *real* question behind the prompt — not "did it come from a folder source once", but
    /// "would a scan find it again tomorrow". So it's answered by looking, mapping the vault path back
    /// through the source's `mountPath` to its location on disk. A paused source can't rediscover anything,
    /// so it doesn't count. Never throws for a missing/odd source; a source we can't resolve simply isn't a
    /// match, which keeps the prompt quiet rather than crying wolf.
    private func isUnderWatchedFolder(_ session: UserSession, _ path: String) throws -> Bool {
        for source in try session.journal.listSources()
        where source.kind == .folder && !source.paused {
            guard let root = source.path else { continue }
            let mount = source.mountPath
            let prefix = mount.isEmpty ? "" : "\(mount)/"
            guard path == mount || prefix.isEmpty || path.hasPrefix(prefix) else { continue }
            let sub = path == mount ? "" : String(path.dropFirst(prefix.count))
            let onDisk = sub.isEmpty ? root : "\(root)/\(sub)"
            if FileManager.default.fileExists(atPath: onDisk) { return true }
        }
        return false
    }
    /// `authenticate`'s result: the Cognito identity id this daemon's uploads are now scoped under
    /// (`blobs/<identityId>`) — surfaced mainly for the UI/logs, since the daemon itself just reads
    /// `cognitoAuth.vaultPrefix` on the next run.
    private struct AuthDTO: Encodable { let ok: Bool; let identityId: String }
    /// `mintVault`'s result (signup) — and `reissueRecoveryCode`'s, which returns the same shape with a
    /// re-wrap of the EXISTING MK: the key-blob to store server-side (base64 ciphertexts + salts), the
    /// one-time recovery code to show the user ONCE, and the MasterKey (base64) for the app
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
        let listed = try await session.restoreEngine.store.usageBytes(prefix: prefix)
        // S3 keeps listing an object until it is physically removed, and lifecycle runs once a day — so the
        // listing lags reality by up to a day or more. Subtract blobs we've tagged whose 180-day minimum has
        // already run out: AWS has stopped charging us for those, so the user should have the space back.
        // Never credit a blob still inside its minimum — we're still paying, so they're still holding it.
        //
        // KNOWN IMPRECISION, deliberately conservative: `f.size` is PLAINTEXT bytes while `listed` is
        // ciphertext, so the credit under-shoots by the AEAD tag overhead (~4 ppm). And the credit expires on
        // a time window rather than on the object actually leaving the listing. Both err the same way — usage
        // reads slightly HIGH — so a deposit is refused marginally early rather than a plan being overrun.
        // The exact fix is to have `usageBytes` return key→size and credit only listed reaped objects.
        //
        // Credit is journal-derived and therefore per-device. A second Mac that didn't perform the delete
        // won't credit it and will read usage HIGH until S3 drops the object — conservative, so the failure
        // mode is a deposit refused slightly early, never a plan quietly overrun. Making this exact across
        // devices needs a server-side index, not a bigger local sum.
        let credit = (try? session.journal.reclaimedCreditBytes()) ?? 0
        let bytes = max(0, listed - credit)
        cachedUsage = (prefix: prefix, bytes: bytes, at: Date())
        return bytes
    }

    /// Decode a base64 32-byte key param, or nil if absent. Throws on present-but-malformed (wrong length
    /// or bad base64) rather than silently truncating — a wrong-sized key would corrupt every blob.
    private func decodeKey(_ raw: String?) throws -> SymmetricKey? {
        guard let raw else { return nil }
        guard let data = Data(base64Encoded: raw), data.count == 32 else {
            throw ColdStorageError.invalidRequest("masterKey must be base64 of exactly 32 bytes")
        }
        return SymmetricKey(data: data)
    }

    /// Reconstruct a `KeyBlob` from the flat `[String:String]` control params (base64 ciphertexts/salts +
    /// integer tuning). The app passes the six fields straight through from the backend's key-blob JSON.
    private func keyBlob(from p: [String: String]) throws -> KeyBlob {
        func b64(_ key: String) throws -> Data {
            guard let raw = p[key], let d = Data(base64Encoded: raw) else {
                throw ColdStorageError.invalidRequest("keyBlob field '\(key)' missing or not base64")
            }
            return d
        }
        func int(_ key: String) throws -> Int {
            guard let raw = p[key], let v = Int(raw) else { throw ColdStorageError.invalidRequest("keyBlob field '\(key)' missing or not an integer") }
            return v
        }
        return KeyBlob(wrappedMKPassword: try b64("wrappedMKPassword"), saltPassword: try b64("saltPassword"),
                       wrappedMKRecovery: try b64("wrappedMKRecovery"), saltRecovery: try b64("saltRecovery"),
                       opsLimit: try int("opsLimit"), memLimit: try int("memLimit"))
    }
    /// One resolved target of a `previewDeposit` dry-run: the vault path the item WOULD land at, and whether
    /// a live row already sits there (a collision the UI prompts on).
    /// `suggestedPack` is the `ExcludeSuggestion.id` that WOULD have skipped this item had the user turned
    /// that pack on — the deposit-time prompt's whole input. nil (the normal case) means we'd archive it.
    private struct DepositPreviewItemDTO: Encodable {
        let relativePath: String; let size: Int; let exists: Bool; let suggestedPack: String?
    }
    /// One idempotent restore step's outcome. `state` ∈ restored | thawRequested | thawInProgress —
    /// re-issue `restore` until it's `restored`. `out` is set only when bytes landed; `tier`/`typicalWait`
    /// only while thawing, so the UI can show the quoted wait.
    /// `restorePlan`'s result: everything the account backend needs to price a restore. `blobKeys` is
    /// DEDUPED (one thaw per blob, however many files ride in it); `egressBytes` is the plaintext-span
    /// total that will actually come back.
    private struct RestorePlanDTO: Encodable { let blobKeys: [String]; let egressBytes: Int }

    // A `RestoreDTO` + `restoreResult(file:out:outcome:)` pair used to live here, behind a one-shot
    // `restore` command that returned a single engine step to the caller. Both were DELETED (2026-07-27)
    // along with that command, and should not come back.
    //
    // The shape was the bug: a restore is a DAYS-LONG process, and modelling it as a request/response the
    // app fires once made the app the only thing holding it. Nothing re-issued the step, so every transfer
    // stalled at `thawRequested` forever; the record lived in renderer memory, so it vanished on sign-out
    // and on restart; and there was no state for "bytes are actually moving", so the whole ~48h thaw was
    // labelled "Downloading". One shape, three user-visible failures.
    //
    // A transfer is now a durable JOURNAL ROW (`RestoreRow`) that the run loop drives (`restorePass`), and
    // the app reads the list rather than accumulating its own copy. If you want to start one, that's
    // `requestRestore`; if you want to know where one stands, that's `listRestores`.

    /// One requested transfer, as the app's Transfers page renders it. The journal row plus the two things
    /// only the daemon can say: the file's current vault path (rows are keyed by id, and a file can be
    /// renamed mid-transfer) and whether a stopped transfer can be resumed for free.
    private struct RestoreRowDTO: Encodable {
        let id, fileId, relativePath, out, state, tier: String
        let jobId: String?
        let bytes, requestedAt: Int
        let readyAt, lastStepAt, completedAt: Int?
        let error: String?
        /// How long the thaw takes, in plain words — so the app never invents its own wait.
        let typicalWait: String
        /// The same wait in seconds, so the app can count down to a ready-by time rather than restate a
        /// static "~48 hours" for two days. Estimate, not a promise — see `RestoreTier.typicalWaitSeconds`.
        let typicalWaitSeconds: Int
        /// Unix seconds the thawed copy stops being free to download (`readyAt` + the 5-day window). Null
        /// until the thaw is ready, because the window has not opened yet and any date here would be fiction.
        let freeUntil: Int?
        /// True ⇒ "Resume" costs nothing: the blobs this job already paid to thaw are still warm.
        let resumable: Bool

        /// Written by hand for ONE reason: the synthesized encoder uses `encodeIfPresent` for optionals, so
        /// a nil `readyAt`/`completedAt`/`error` would be OMITTED from the JSON entirely. `protocol.ts`
        /// declares those as `T | null`, which is a promise that the key is always there — a reader doing
        /// `row.readyAt === null` would get `undefined` and quietly take the wrong branch. Encoding the
        /// nulls explicitly makes the wire match the contract the app is typed against.
        // Declared, not synthesized: writing `encode(to:)` by hand suppresses the compiler's own.
        enum CodingKeys: String, CodingKey {
            case id, fileId, relativePath, out, state, tier, jobId, bytes, requestedAt
            case readyAt, lastStepAt, completedAt, error, typicalWait, typicalWaitSeconds, freeUntil
            case resumable
        }

        func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(id, forKey: .id)
            try c.encode(fileId, forKey: .fileId)
            try c.encode(relativePath, forKey: .relativePath)
            try c.encode(out, forKey: .out)
            try c.encode(state, forKey: .state)
            try c.encode(tier, forKey: .tier)
            try c.encode(jobId, forKey: .jobId)              // `encode`, not `encodeIfPresent` — emits null
            try c.encode(bytes, forKey: .bytes)
            try c.encode(requestedAt, forKey: .requestedAt)
            try c.encode(readyAt, forKey: .readyAt)
            try c.encode(lastStepAt, forKey: .lastStepAt)  // `encode`, not `encodeIfPresent` — emits null
            try c.encode(completedAt, forKey: .completedAt)
            try c.encode(error, forKey: .error)
            try c.encode(typicalWait, forKey: .typicalWait)
            try c.encode(typicalWaitSeconds, forKey: .typicalWaitSeconds)
            try c.encode(freeUntil, forKey: .freeUntil)      // `encode`, not `encodeIfPresent` — emits null
            try c.encode(resumable, forKey: .resumable)
        }
    }

    private func restoreRowDTOs(_ session: UserSession) throws -> [RestoreRowDTO] {
        // One read of the tree, then an in-memory lookup — a vault is personal-scale, and this beats a
        // per-row query. A row whose file was since deleted keeps its recorded destination as its name, so
        // a completed transfer never disappears from history just because the vault copy was tidied away.
        let paths = Dictionary(try session.journal.listFiles().map { ($0.id, $0.relativePath) },
                               uniquingKeysWith: { a, _ in a })
        let now = Int(Date().timeIntervalSince1970)
        return try session.journal.listRestores().map { r in
            RestoreRowDTO(id: r.id, fileId: r.fileId,
                          relativePath: paths[r.fileId] ?? URL(fileURLWithPath: r.out).lastPathComponent,
                          out: r.out, state: r.state.rawValue, tier: r.tier.rawValue, jobId: r.jobId,
                          bytes: r.bytes, requestedAt: r.requestedAt, readyAt: r.readyAt,
                          lastStepAt: r.lastStepAt, completedAt: r.completedAt, error: r.error,
                          typicalWait: r.tier.typicalWait, typicalWaitSeconds: r.tier.typicalWaitSeconds,
                          freeUntil: r.readyAt.map { $0 + RestoreRow.thawWindowSeconds },
                          resumable: r.isResumable(now: now))
        }
    }

    /// Tell every live watcher the transfer list moved. One event for the whole list (the app re-reads
    /// `listRestores`) rather than a per-state event carrying a fragment: the journal is the SSOT, and a
    /// renderer folding its own parallel copy from event fragments is exactly the arrangement that lost a
    /// user's in-flight transfer on sign-out.
    private func publishRestoresChanged() {
        bus.publish(DaemonEvent("restoresChanged", [:]))
    }

    private func sourceDTOs(_ session: UserSession) throws -> [SourceDTO] {
        try session.journal.listSources().map { SourceDTO(id: $0.id, kind: $0.kind.rawValue, path: $0.path, mountPath: $0.mountPath,
                                                  paused: $0.paused, lastScanAt: $0.lastScanAt, error: $0.error) }
    }


    /// Push every in-flight transfer one step, once per run-loop pass.
    ///
    /// This is what makes a transfer real. `RestoreEngine.restore` is idempotent and self-progressing by
    /// design — request the thaw, report it's warming, download once ready — but something has to *re-run*
    /// it, and until this existed nothing did: the app fired one `restore`, got `thawRequested` back, and
    /// that was the end of it. Every transfer sat frozen at step one forever, while the UI showed it as
    /// "Downloading". So the fix for the wrong label and the fix for the stalled transfer are the same fix.
    ///
    /// Runs on the daemon's own loop, so a transfer progresses with the app closed — which the request
    /// dialog has always promised ("You can close the app; we'll let you know when it's ready").
    ///
    /// Each row is stepped independently and a failure is recorded on THAT row, never thrown: one bad
    /// transfer must not abort the pass for the others, and it must not crash the run loop.
    /// Internal (not private) so tests can drive a pass deterministically — production callers are the
    /// run loop and the fire-and-forget kicks (`requestRestore`/`resumeRestore`/`authenticate`).
    func restorePass(_ session: UserSession) async {
        // Skip if a pass is already in flight; it will pick up anything this one would have. No `await`
        // between the check and the set, so the acquire is atomic on the actor — no reentrancy gap.
        if restoring { return }
        restoring = true
        defer { restoring = false }

        let active: [RestoreRow]
        do { active = try session.journal.activeRestores() } catch { return }
        guard !active.isEmpty else { return }

        // Captured for the `willDownload` callback below, which deliberately runs OFF the actor.
        let bus = self.bus
        let journal = session.journal

        for row in active {
            // `needsAuthorization` rows are stepped too, even though the move is the app's (the backend has
            // to be paid before anything can thaw). Skipping them would make the state a dead end: if those
            // blobs DO get thawed — the user re-quoted and paid, warming the very same objects — the row
            // could never notice, because the only way to know is to ask S3. A HeadObject per pass is
            // nothing, and it buys a state that heals itself instead of one that needs rescuing.
            let now = Int(Date().timeIntervalSince1970)
            // Stamp that we looked, whatever comes of looking. Unconditional by construction (`defer`), and
            // its own write rather than folded into `setRestoreState`, because that only fires on NEWS — and
            // a healthy pending row's news is precisely that there is none. See `RestoreRow.lastStepAt`.
            defer { try? session.journal.stampRestoreStep(row.id, at: now) }
            do {
                let outcome = try await session.restoreEngine.restore(
                    fileId: row.fileId, to: URL(fileURLWithPath: row.out), tier: row.tier,
                    days: RestoreRow.thawWindowSeconds / 86_400,
                    // Fires the instant the thaw is confirmed ready and bytes start moving. Recording it
                    // here (rather than after the download returns) is the whole point: this is the window
                    // during which "Transferring" is a true statement.
                    //
                    // Written INLINE rather than hopped onto the actor with a `Task`. Hopping would queue
                    // the flip behind the download that is about to start, so a transfer could finish and
                    // write `saved` before the `transferring` flip landed — leaving a delivered file stuck
                    // reading "Transferring" forever. Journal and bus each carry their own lock, so doing
                    // it here is both safe and correctly ordered.
                    //
                    // `readyAt` is stamped only the first time (COALESCE in the journal), so a resumed
                    // transfer keeps the window start it already had instead of pretending it just thawed.
                    willDownload: {
                        try? journal.setRestoreState(row.id, .transferring, readyAt: row.readyAt ?? now)
                        bus.publish(DaemonEvent("restoresChanged", [:]))
                    },
                    // Once per decrypted frame (~4 MiB): plaintext bytes on disk so far. Ephemeral by
                    // design — the bar's truth is this stream, not the journal (a SQLite write every 4 MiB
                    // for hours would buy nothing: on reconnect the next tick lands within a second).
                    // `totalBytes` is the row's own plaintext size, the same figure the page already shows,
                    // so numerator and denominator can never disagree about units. Runs OFF the actor,
                    // inline, exactly like `willDownload` above — the bus carries its own lock.
                    onProgress: { plainBytes in
                        bus.publish(DaemonEvent("restoreProgress", ["id": row.id, "file": row.fileId,
                                                                    "bytes": "\(plainBytes)",
                                                                    "totalBytes": "\(row.bytes)"]))
                    })

                switch outcome {
                case .restored:
                    try session.journal.setRestoreState(row.id, .saved, completedAt: now)
                    bus.publish(DaemonEvent("restoreCompleted", ["file": row.fileId, "out": row.out]))
                case .thawInProgress, .thawRequested:
                    // Still warming. Only NEWS is worth a write + event: a state change, or a recorded
                    // fault this successful step just disproved. `setRestoreState` clears `error` (a
                    // recorded fault is history the moment the thing succeeds — see Journal), and a row
                    // whose state didn't move never reaches it via the state check alone, so without the
                    // `error` leg a transient snag ("token expired" after an overnight sleep) would stay
                    // pinned to a healthy transfer for the rest of a days-long thaw. A row that was
                    // already clean and `pending` last pass still writes/announces nothing.
                    if row.state != .pending || row.error != nil {
                        try session.journal.setRestoreState(row.id, .pending)
                    }
                case .authorizationRequired:
                    // The backend hasn't thawed these blobs (payment never landed, or the 5-day window
                    // lapsed and they refroze). Honest state: this needs authorizing again, and the app
                    // must re-quote rather than wait on a thaw that is never coming. Same `error` leg as
                    // above: a step that ANSWERED (even "pay first") clears any stale snag note.
                    if row.state != .needsAuthorization || row.error != nil {
                        try session.journal.setRestoreState(row.id, .needsAuthorization)
                    }
                }
            } catch {
                // Classify before condemning — via `FailureKind`, the same SSOT the upload path uses, so
                // there is one answer in this codebase to "is this worth another try?".
                //
                // Marking every error `.failed` (as this first did) is a data-loss-shaped bug: `.failed`
                // is not active, so the run loop never touches the row again. One flaky HeadObject in the
                // middle of a 48-hour wait would permanently strand a transfer the user PAID for, with no
                // retry and nothing to notice it — they'd have to spot it and press Pick back up themselves.
                //
                // So transient faults leave the row exactly where it is (the next pass retries, which is
                // the whole point of a self-progressing engine) and only record WHY, so the page can say
                // we hit a snag and are still going. Only a permanent fault — a hash mismatch, AccessDenied,
                // a config fault — is terminal.
                let kind = FailureKind.classify(error)
                try? session.journal.recordRestoreFault(row.id, kind.isPermanent ? .failed : row.state,
                                                        error: kind.message)
            }
        }
        // Unconditional, where this used to fire only on state news: every active row's `lastStepAt` just
        // moved, so "we checked, still warming" IS the report. Withholding it is what let the page render a
        // month-old wait as a live one. (Non-empty work list guaranteed — the empty case returned above.)
        publishRestoresChanged()
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
                                              running: false, permanentlyFailedBlobs: 0, sources: [], bytesStored: nil,
                                              staleAfterSeconds: RestoreRow.staleAfter(intervalSeconds: intervalSeconds)))
            }
            let s = try session.journal.summary()
            return AnyEncodable(StatusDTO(signedIn: true, filesTotal: s.total, filesArchived: s.archived,
                                          blobsVerified: s.blobsVerified, running: running,
                                          permanentlyFailedBlobs: permanentlyFailedBlobs.count,
                                          sources: try sourceDTOs(session),
                                          // `try?`, deliberately: this is the ONE field backed by a live,
                                          // paginated S3 listing, so it is the one that can be slow or fail
                                          // (expired STS, AccessDenied) while every other field — all read
                                          // from the local journal — is sound. Letting it throw took the
                                          // whole snapshot down, and the client's 10 s request deadline
                                          // turned a slow listing into no status at all. A degraded field
                                          // the UI can label beats a status call that answers nothing.
                                          bytesStored: try? await currentUsageBytes(session),
                                          staleAfterSeconds: RestoreRow.staleAfter(intervalSeconds: intervalSeconds)))
        case "listSources":
            guard let session else { return AnyEncodable([SourceDTO]()) }
            return AnyEncodable(try sourceDTOs(session))
        case "listFiles":
            // The browsable tree, straight from THIS USER'S journal — paths/sizes/status, no S3, no thaw.
            guard let session else { return AnyEncodable([FileDTO]()) }
            return AnyEncodable(try session.journal.listFiles().map {
                FileDTO(id: $0.id, relativePath: $0.relativePath, size: $0.size, status: $0.status.rawValue, blobId: $0.blobId,
                        date: $0.createdAt, lastAttemptAt: $0.lastAttemptAt, error: $0.error)
            })
        case "listExcludes":
            guard let session else { return AnyEncodable([String]()) }
            return AnyEncodable(try session.journal.listExcludes())
        case "listExcludeSuggestions":
            // The opt-in packs (`ExcludeSuggestion.all`) — junk we know about but only some people have, so
            // we offer it instead of seeding it. Session-independent: it's a static catalogue, not user
            // state, and whether a pack is "on" is derived by the caller from `listExcludes`.
            return AnyEncodable(ExcludeSuggestion.all)
        case "addSource":
            let session = try requireSession("addSource")
            guard let raw = p["path"] else { throw ColdStorageError.invalidRequest("addSource requires params.path") }
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
            guard let id = p["id"] else { throw ColdStorageError.invalidRequest("removeSource requires params.id") }
            try session.journal.removeSource(id)
            bus.publish(DaemonEvent("sourcesChanged", ["removed": id]))
            return AnyEncodable(AckDTO(ok: true))
        case "addExclude":
            let session = try requireSession("addExclude")
            // Register a gitignore-style pattern; it filters every later scan/deposit. Trim so a stray-space
            // paste doesn't create a pattern that matches nothing.
            let pattern = (p["pattern"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !pattern.isEmpty else { throw ColdStorageError.invalidRequest("addExclude requires a non-empty params.pattern") }
            try session.journal.addExclude(pattern)
            bus.publish(DaemonEvent("excludesChanged", ["added": pattern]))
            return AnyEncodable(AckDTO(ok: true))
        case "removeExclude":
            let session = try requireSession("removeExclude")
            guard let pattern = p["pattern"] else { throw ColdStorageError.invalidRequest("removeExclude requires params.pattern") }
            try session.journal.removeExclude(pattern)
            bus.publish(DaemonEvent("excludesChanged", ["removed": pattern]))
            return AnyEncodable(AckDTO(ok: true))
        case "restorePlan":
            let session = try requireSession("restorePlan")
            // What restoring these files would actually COST US to serve — the input to the account
            // backend's `POST /retrieval/quote` (root RETRIEVAL.md). The app calls this BEFORE it shows a
            // price, because a restore is priced on two things the renderer cannot know: the whole BLOB
            // objects that must be thawed (blobs are packed, so one photo can drag a 256 MiB blob with it)
            // and the bytes that actually come back.
            //
            // Blob keys are DEDUPED: several files usually share one blob, and that blob is thawed — and
            // billed — exactly once. Charging per-file here would overcharge the common case badly.
            guard let raw = p["files"], !raw.isEmpty else {
                throw ColdStorageError.invalidRequest("restorePlan requires params.files (newline-joined fileIds)")
            }
            var keys: [String] = []
            var seen = Set<String>()
            var egress = 0
            for fileId in raw.split(separator: "\n").map(String.init) {
                guard let f = try session.journal.fileMapping(fileId) else { throw ColdStorageError.invalidRequest("no archived file '\(fileId)'") }
                guard let key = try session.journal.blobS3Key(f.blobId) else { throw ColdStorageError.invalidRequest("no S3 key for blob \(f.blobId)") }
                egress += f.length
                if seen.insert(key).inserted { keys.append(key) }
            }
            return AnyEncodable(RestorePlanDTO(blobKeys: keys, egressBytes: egress))
        case "listRestores":
            // Signed out ⇒ empty, like every other read here: transfers are vault data.
            guard let session else { return AnyEncodable([RestoreRowDTO]()) }
            return AnyEncodable(try restoreRowDTOs(session))
        case "requestRestore":
            let session = try requireSession("requestRestore")
            guard let file = p["file"] else { throw ColdStorageError.invalidRequest("requestRestore requires params.file (the fileId)") }
            guard let out = p["out"] else { throw ColdStorageError.invalidRequest("requestRestore requires params.out (output path)") }
            guard let f = try session.journal.fileMapping(file) else {
                throw ColdStorageError.invalidRequest("no archived file '\(file)'")
            }
            // A NEW request for a file supersedes any transfer of it still in flight. Without this, the
            // "Ask again" route out of a stalled `needsAuthorization` transfer leaves the dead row behind:
            // it is still `isActive`, so it sits in "In progress" and pads the sidebar count forever, beside
            // the live transfer that replaced it. Stopping it says what actually happened — this request took
            // over — and costs nothing, since a superseded row never paid for a thaw of its own.
            for stale in (try? session.journal.activeRestores())?.filter({ $0.fileId == file }) ?? [] {
                try? session.journal.setRestoreState(stale.id, .canceled)
            }
            // RECORD FIRST, step second. The row is what makes this transfer survive a restart, a sign-out,
            // and a closed app — and the user may already have PAID for it by the time we get here, so it
            // must be durable before any network call gets a chance to fail.
            //
            // Tier is NOT a parameter. Bulk is the only tier the backend quotes at, so requesting a faster
            // one would spend money we never charged for (root RETRIEVAL.md) — and a wire param the caller
            // can set is exactly how that happens by accident. There is nothing to get wrong if there is
            // nothing to pass.
            let row = RestoreRow(id: UUID().uuidString, fileId: file, out: out, jobId: p["jobId"],
                                 state: .pending, tier: .bulk, bytes: f.length,
                                 requestedAt: Int(Date().timeIntervalSince1970))
            try session.journal.addRestore(row)
            publishRestoresChanged()
            // Take the first step right away so a thaw that's already warm downloads now rather than at the
            // next interval; from here the run loop owns it.
            Task { await self.restorePass(session) }
            return AnyEncodable(try restoreRowDTOs(session))
        case "cancelRestore":
            let session = try requireSession("cancelRestore")
            guard let id = p["id"] else { throw ColdStorageError.invalidRequest("cancelRestore requires params.id") }
            guard let row = try session.journal.restore(id: id) else {
                throw ColdStorageError.invalidRequest("no transfer '\(id)'")
            }
            guard row.state.isActive else { throw ColdStorageError.invalidRequest("that transfer already finished") }
            // Stops the COPY, not the thaw. A Glacier retrieval cannot be called back and the money is
            // already spent, so this is honest only because `resumeRestore` is free while the window lasts —
            // the app's copy must say so plainly rather than imply a refund (root RETRIEVAL.md).
            try session.journal.setRestoreState(id, .canceled)
            publishRestoresChanged()
            return AnyEncodable(try restoreRowDTOs(session))
        case "resumeRestore":
            let session = try requireSession("resumeRestore")
            guard let id = p["id"] else { throw ColdStorageError.invalidRequest("resumeRestore requires params.id") }
            guard try session.journal.restore(id: id) != nil else {
                throw ColdStorageError.invalidRequest("no transfer '\(id)'")
            }
            // Re-open even when the thaw window has lapsed: the next pass will discover the blobs are cold
            // again and land the row on `needsAuthorization`, which is the truthful answer and routes the
            // user to a fresh quote. Deciding "too late" here would mean guessing at S3's state instead of
            // asking it.
            try session.journal.reopenRestore(id, .pending)
            publishRestoresChanged()
            Task { await self.restorePass(session) }
            return AnyEncodable(try restoreRowDTOs(session))
        case "forgetRestore":
            let session = try requireSession("forgetRestore")
            guard let id = p["id"] else { throw ColdStorageError.invalidRequest("forgetRestore requires params.id") }
            guard let row = try session.journal.restore(id: id) else {
                throw ColdStorageError.invalidRequest("no transfer '\(id)'")
            }
            // History-only: clearing a finished transfer's record. An in-flight one must be stopped first,
            // or the run loop would keep driving a transfer the user believes they dismissed.
            guard !row.state.isActive else { throw ColdStorageError.invalidRequest("stop that transfer before clearing it") }
            try session.journal.deleteRestore(id)
            publishRestoresChanged()
            return AnyEncodable(try restoreRowDTOs(session))
        case "deposit":
            _ = try requireSession("deposit")
            // Ad-hoc drop-to-upload: archive these paths once, under the browser folder `dest` ("" = root).
            // `src` is newline-joined absolute paths (one deposit covers a whole multi-file/folder drop).
            guard let raw = p["src"], !raw.isEmpty else { throw ColdStorageError.invalidRequest("deposit requires params.src (newline-joined absolute paths)") }
            let paths = raw.split(separator: "\n").map(String.init)
            let dest = p["dest"] ?? ""
            // Optional collision resolutions from the UI's Keep Both / Replace / Skip prompt (JSON map,
            // keyed by vault relativePath). Absent → no collisions to resolve, deposit as-is.
            let conflicts = parseConflicts(p["conflicts"])
            // Patterns the user chose to skip for THIS DROP ONLY, at the deposit-time suggestion prompt.
            // Deliberately separate from the excludes registry: "not this time" and "never again" are
            // different answers, and the app must be able to offer the first without quietly performing the
            // second. Choosing "remember this" is a separate `addExclude` the app issues by itself.
            let extra = (p["excludeExtra"] ?? "").split(separator: "\n").map(String.init).filter { !$0.isEmpty }
            // Fire-and-forget: archiving can be slow, so don't block the reply. Progress + outcome flow as
            // runStarted/fileArchived/blobFailed/runFinished events (exactly like a scheduled run).
            Task { await self.deposit(paths: paths, into: dest, conflicts: conflicts, excludeExtra: extra) }
            return AnyEncodable(AckDTO(ok: true))
        case "depositPhotos":
            _ = try requireSession("depositPhotos")
            // Explicit photo deposit (the photo analogue of `deposit`): archive these PICKED Photos assets
            // once, under browser folder `dest` ("" = root). `assetIds` is newline-joined Photos
            // localIdentifiers. Only the picked assets are read — never the whole library (product decision
            // 2026-06-26). Fire-and-forget: progress/outcome flow as run*/fileArchived/blobFailed events.
            guard let raw = p["assetIds"], !raw.isEmpty else { throw ColdStorageError.invalidRequest("depositPhotos requires params.assetIds (newline-joined Photos localIdentifiers)") }
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
            // `previewPaths`, NOT `enumerate`. Enumerating SHA-256s every file — a full read of every byte in
            // the drop — and the preview throws all of that away, keeping only the names. On a 1000-file
            // deposit that read is minutes of work in front of a UI that gives up after 10 seconds, so the
            // whole thing looked hung before a single row appeared. The preview is now a stat-only walk.
            let previews: [DepositPreviewPath]
            if let raw = p["src"], !raw.isEmpty {
                let entries = raw.split(separator: "\n").map { ExplicitPathsSource.Entry(url: URL(fileURLWithPath: String($0)), destDir: dest) }
                previews = try await ExplicitPathsSource(entries: entries, exclude: excludeMatcher(session),
                                                         suggest: suggestionMatcher(session)).previewPaths()
            } else if let raw = p["assetIds"], !raw.isEmpty {
                guard let resolver = photoResolver else { throw ColdStorageError.invalidRequest("previewDeposit: Photos ingest is unavailable on this platform") }
                previews = try await PhotoDepositSource(resolver: resolver, assetIds: raw.split(separator: "\n").map(String.init),
                                                        destDir: dest, scratchDir: session.scratchDir).previewPaths()
            } else {
                throw ColdStorageError.invalidRequest("previewDeposit requires params.src (paths) or params.assetIds")
            }
            let live = try session.journal.livePaths()
            return AnyEncodable(previews.map {
                DepositPreviewItemDTO(relativePath: $0.relativePath, size: $0.size, exists: live.contains($0.relativePath),
                                      suggestedPack: $0.suggestedBy.flatMap(ExcludeSuggestion.packId(forPattern:)))
            })
        case "movePath":
            let session = try requireSession("movePath")
            // Reorganize: relocate the subtree at `from` → `to` (a file/folder move OR rename). A cheap
            // journal `relativePath` edit — no S3, no thaw, the blob never moves. `filesChanged` tells a live
            // watcher to re-read the tree.
            guard let from = p["from"] else { throw ColdStorageError.invalidRequest("movePath requires params.from (a vault-relative path)") }
            guard let to = p["to"] else { throw ColdStorageError.invalidRequest("movePath requires params.to (the new vault-relative path)") }
            try session.journal.movePath(from: from, to: to)
            bus.publish(DaemonEvent("filesChanged", ["moved": from, "to": to]))
            return AnyEncodable(AckDTO(ok: true))
        case "createFolder":
            let session = try requireSession("createFolder")
            // Anchor an empty folder so it survives a reload (the tree is derived from file paths, so an
            // empty one otherwise has nothing to imply it). A path-only journal marker — no S3, no thaw.
            // Idempotent on the path. `filesChanged` tells a live watcher to re-read the tree.
            guard let path = p["path"], !path.isEmpty else { throw ColdStorageError.invalidRequest("createFolder requires params.path (a vault-relative folder path)") }
            try session.journal.createFolder(path: path)
            bus.publish(DaemonEvent("filesChanged", ["created": path]))
            return AnyEncodable(AckDTO(ok: true))
        case "pathIsWatched":
            // Asked BEFORE the delete, so the confirm dialog can state the consequence up front and offer
            // the fix in the same breath — rather than deleting first and explaining afterwards, which is
            // how you end up telling someone to go configure an exclusion themselves.
            let session = try requireSession("pathIsWatched")
            guard let path = p["path"] else { throw ColdStorageError.invalidRequest("pathIsWatched requires params.path (a vault-relative path)") }
            return AnyEncodable(WatchedDTO(isWatched: try isUnderWatchedFolder(session, path)))
        case "deletePath":
            let session = try requireSession("deletePath")
            // Tombstone the subtree at `path` (file or folder): it leaves `listFiles` immediately, and its
            // bytes are reclaimed once every file in their blob is gone (`UploadEngine.reapDeleted`).
            guard let path = p["path"] else { throw ColdStorageError.invalidRequest("deletePath requires params.path (a vault-relative path)") }
            try session.journal.deletePath(path)
            // **Deleting something that lives in a watched folder, without also ignoring it, is a trap.** The
            // folder is still watched and the file is still on disk, so every future scan would find it again.
            // The tombstone now outranks a rescan (`Journal.upsert`), so it won't silently return — but it
            // WOULD stay permanently un-backed-up with nothing saying why. So the client tells the user
            // plainly and offers one button; `alsoIgnore` is that button, and we do the work rather than
            // handing them a chore. `isWatched` lets the client know whether to ask at all.
            let watched = try isUnderWatchedFolder(session, path)
            if watched, p["alsoIgnore"] == "true" {
                // The vault-relative path IS the pattern. Anything nested contains a `/` and so is matched
                // anchored, exactly as intended. A root-level name has no `/` and becomes a name pattern
                // (ExcludeMatcher's gitignore rule), which can match that name at any depth — broader than
                // asked for, but still strictly "don't back this up", never the reverse.
                try session.journal.addExclude(path)
                // Same event every other exclude mutation publishes — the Settings "Don't back up" card
                // learns about this one through its own channel, rather than relying on a listExcludes
                // refresh piggybacking on `filesChanged`.
                bus.publish(DaemonEvent("excludesChanged", ["added": path]))
            }
            bus.publish(DaemonEvent("filesChanged", ["deleted": path]))
            return AnyEncodable(DeleteResultDTO(ok: true, isWatched: watched, ignored: watched && p["alsoIgnore"] == "true"))
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
            guard let auth = cognitoAuth else { throw ColdStorageError.invalidRequest("authenticate: this daemon has no Cognito identity pool configured") }
            guard let idToken = p["idToken"] else { throw ColdStorageError.invalidRequest("authenticate requires params.idToken") }
            let identityId = try await auth.authenticate(idToken: idToken)
            // Safe to read the token's claims un-verified ONLY here, and only because `auth.authenticate`
            // above just had Cognito accept this very token (see IDToken).
            let sub = try IDToken.sub(of: idToken)
            let active: UserSession
            if let current = session, current.belongs(toSub: sub) {
                active = current
            } else {
                active = try sessions.make(.user(sub: sub, identityId: identityId))
                beginSession(active)
            }
            // Fresh credentials just landed — push in-flight transfers NOW rather than waiting out the
            // run loop's beat. This is the recovery half of the post-sleep story: the wake-up pass fails
            // on the stale token, the app re-authenticates within moments, and this kick turns "heals
            // within 5 minutes" into "heals immediately". Same fire-and-forget shape as the transfer
            // commands; `restorePass` no-ops when nothing is active.
            Task { await self.restorePass(active) }
            return AnyEncodable(AuthDTO(ok: true, identityId: identityId))
        case "deauthenticate":
            // **Sign-out: where a session dies.** Drop the STS creds immediately (rather than letting them
            // ride out the ~1h expiry) AND release the session — which closes the door on the journal, the
            // staging dir and the MasterKey in one move.
            //
            // This is the fix for the 2026-07-13 cross-account leak: sign-out used to drop only the
            // credentials and the key, leaving a machine-wide journal that the NEXT account then read as
            // its own. Now there is no such journal to leave behind.
            guard let auth = cognitoAuth else { throw ColdStorageError.invalidRequest("deauthenticate: this daemon has no Cognito identity pool configured") }
            await auth.deauthenticate()
            endSession()
            return AnyEncodable(AckDTO(ok: true))
        case "setQuota":
            // The app pushes the signed-in account's storage quota here (from its `/entitlement` fetch),
            // right after authenticate and whenever the entitlement changes — so the engine can enforce a
            // ceiling it has no other way to learn (the daemon doesn't talk to the account backend). Absent
            // or unparseable `quotaBytes` CLEARS it → don't enforce (a subscriber whose plan the app couldn't
            // resolve, or dogfood mode) — the same fail-open the app-side gate uses. Cheap, no session needed.
            setQuota(p["quotaBytes"].flatMap(Int.init))
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
            guard let mk = try decodeKey(p["masterKey"]) else { throw ColdStorageError.invalidRequest("unlockVault requires params.masterKey (base64)") }
            session.vaultKey.setMasterKey(mk)
            return AnyEncodable(AckDTO(ok: true))
        case "unlockVaultWithRecoveryCode":
            // New device: the app fetched the key-blob from the backend and prompted for the recovery code.
            // Unwrap MK (a wrong code fails closed via the AES-GCM tag), load it live, and return it so the
            // app can escrow it — this device won't need the code again.
            let session = try requireSession("unlockVaultWithRecoveryCode")
            let blob = try keyBlob(from: p)
            guard let code = p["recoveryCode"] else { throw ColdStorageError.invalidRequest("unlockVaultWithRecoveryCode requires params.recoveryCode") }
            let mk = try ZeroKnowledgeKeys.unlockWithRecoveryCode(blob, recoveryCode: code)
            session.vaultKey.setMasterKey(mk)
            return AnyEncodable(UnlockVaultDTO(ok: true, masterKey: mk.withUnsafeBytes { Data($0).base64EncodedString() }))
        case "reissueRecoveryCode":
            // A fresh one-time recovery code for an ALREADY-UNLOCKED vault — the "you didn't finish saving
            // your code" onboarding re-show (ui/DESIGN.md), and later any Settings-driven reissue. Wraps the
            // session's LIVE MK (never a client-supplied key, so the new blob can't drift from what this
            // session actually encrypts with); DEKs untouched. The old code is dead once the app PUTs the
            // returned blob over the server copy. Locked vault ⇒ `.vaultLocked`, same as a deposit would.
            let session = try requireSession("reissueRecoveryCode")
            let mk = try session.vaultKey.userKEK()
            let recoveryCode = try ZeroKnowledgeKeys.generateRecoveryCode()
            let blob = try ZeroKnowledgeKeys.reissueRecoveryOnly(masterKey: mk, recoveryCode: recoveryCode)
            return AnyEncodable(MintVaultDTO(
                ok: true,
                wrappedMKPassword: blob.wrappedMKPassword.base64EncodedString(),
                saltPassword: blob.saltPassword.base64EncodedString(),
                wrappedMKRecovery: blob.wrappedMKRecovery.base64EncodedString(),
                saltRecovery: blob.saltRecovery.base64EncodedString(),
                opsLimit: blob.opsLimit, memLimit: blob.memLimit,
                recoveryCode: recoveryCode,
                masterKey: mk.withUnsafeBytes { Data($0).base64EncodedString() }))
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
        case "cancelRun":
            // Stop the deposit/scan in flight (see `cancelRun`). `ok` is whether there was one to stop; the
            // outcome arrives as `runFinished` (with `filesStopped`), never as an `error`.
            return AnyEncodable(AckDTO(ok: cancelRun()))
        case "pauseSource":
            let session = try requireSession("pauseSource")
            // Per-folder pause: stop auto-syncing this one source (it stays registered). Persisted, so it
            // survives restart. Manual deposits are unaffected. `sourcesChanged` → the UI refetches.
            guard let id = p["id"] else { throw ColdStorageError.invalidRequest("pauseSource requires params.id") }
            try session.journal.setSourcePaused(id, true)
            bus.publish(DaemonEvent("sourcesChanged", ["paused": id]))
            return AnyEncodable(AckDTO(ok: true))
        case "resumeSource":
            let session = try requireSession("resumeSource")
            guard let id = p["id"] else { throw ColdStorageError.invalidRequest("resumeSource requires params.id") }
            try session.journal.setSourcePaused(id, false)
            bus.publish(DaemonEvent("sourcesChanged", ["resumed": id]))
            trigger()   // sync the just-resumed folder soon, don't wait for the next interval
            return AnyEncodable(AckDTO(ok: true))
        default:
            throw ColdStorageError.invalidRequest("unknown method: \(method)")
        }
    }
}
