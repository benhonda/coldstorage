/**
 * Wire contract for the `coldstored` control plane — a TypeScript MIRROR of the Swift SSOT.
 * Do not invent shapes here; these track the daemon's own definitions and must stay in lockstep:
 *
 *   - Envelopes  → `Sources/ColdStorageCore/ControlProtocol.swift`
 *   - Commands   → `DaemonService.handle` (the command SSOT) + its result DTOs
 *   - Events     → `DaemonEvent(...)` call sites across `DaemonService`
 *
 * Transport is newline-delimited JSON over a unix socket: one `ControlRequest` per line out; one
 * line per message back — a reply (carries `id`) or a pushed event (carries `event`). The client
 * tells them apart by which key is present (see {@link isResponseLine}/{@link isEventLine}).
 *
 * On the wire every param/event value is a STRING (Swift `[String: String]`), even numbers like
 * `days` ("7") or `filesTotal` ("42"). Result DTOs are richer JSON (numbers/bools) — typed per DTO.
 */

// ── Envelopes (ControlProtocol.swift) ────────────────────────────────────────

/** One request line: `{id, method, params?}`. Params are always string-valued on the wire. */
export interface ControlRequest {
  id: number;
  method: string;
  params?: Record<string, string>;
}

/** A reply line: `{id, result?|error?}` — `result` XOR `error`. */
export interface ControlResponseLine {
  id: number;
  result?: unknown;
  error?: string;
}

/** A pushed event line: `{event, data}`. `data` is always string-valued on the wire. */
export interface ControlEventLine {
  event: string;
  data: Record<string, string>;
}

/** Either kind of line the daemon writes back. */
export type ControlLine = ControlResponseLine | ControlEventLine;

export const isResponseLine = (l: ControlLine): l is ControlResponseLine =>
  typeof (l as ControlResponseLine).id === "number";

export const isEventLine = (l: ControlLine): l is ControlEventLine =>
  typeof (l as ControlEventLine).event === "string";

// ── Command results (DaemonService DTOs) ─────────────────────────────────────

/** `AckDTO` — every mutating/no-op command's success shape. */
export interface Ack {
  ok: boolean;
}

/** `SourceDTO` — one registered ingest source. */
export interface Source {
  id: string;
  kind: string;
  path: string | null;
  /** Destination: the vault-relative folder this source's tree mounts under in My Files (e.g.
   * "Backups/Photos"). Daemon-owned placement — set at add time, defaults to the source's basename. */
  mountPath: string;
  /** Per-source pause: when true the scheduled scan skips this folder (still registered, just not
   * auto-synced). Persistent. Toggle via `pauseSource`/`resumeSource`. Manual deposits are unaffected. */
  paused: boolean;
  /** Unix seconds this folder was last SCANNED — stamped every pass, success or failure. Null until the
   * first pass touches it.
   *
   * The third freshness clock, after {@link RestoreRow.lastStepAt} and {@link ListedFile.lastAttemptAt},
   * and the one that matters most: a watched folder IS the promise that files are being backed up, and
   * without a clock that promise couldn't be checked. */
  lastScanAt: number | null;
  /** Why the last scan failed, or null — an unmounted drive, a deleted folder, a revoked permission.
   * Cleared the moment a scan succeeds. Until this existed a folder that had silently stopped backing up
   * was listed in Settings exactly like a working one, and the failure lived only in an ephemeral event. */
  error: string | null;
}

/**
 * `FileDTO` — one browsable file from `listFiles`: the journal IS the tree SSOT (paths/sizes/status),
 * NOT S3 keys. A pure metadata read — no R2, no thaw. `status` is the RAW journal `FileStatus`
 * (`discovered | planned | uploading | verifying | archived | failed`); the renderer coarsens
 * it to its own browse states. `id` doubles as the `file` param of the `restore` command.
 */
export interface ListedFile {
  id: string;
  relativePath: string;
  size: number;
  status: string;
  blobId: string | null;
  /** Capture/creation date as Unix epoch SECONDS, or null when the journal has none (legacy rows). */
  date: number | null;
  /** Unix seconds the upload path last actually TRIED this file — every outcome, success or fault. Null when
   * no attempt has been made yet (scanned into the journal while the daemon was idle, or a legacy row).
   *
   * The upload twin of {@link RestoreRow.lastStepAt}, and needed for the same reason: the tree renders a
   * queued file as "Uploading", and with no clock that claim has no expiry — a file nothing has tried in
   * weeks looks exactly like one mid-flight. */
  lastAttemptAt: number | null;
  /** Why the last attempt failed, or null. Set on a `failed` file (permanent fault) AND on one still queued
   * after a TRANSIENT one — those keep retrying, so the row is honestly still in flight while naming the
   * snag. Cleared the moment an attempt succeeds. */
  error: string | null;
}

/** How a deposit resolves a name-collision (the Finder-style prompt). Mirrors Swift `ConflictPolicy`.
 *  `keepBoth` archives the incoming item under a fresh name; `replace` overwrites the existing file;
 *  `skip` doesn't deposit it. */
export type ConflictPolicy = "keepBoth" | "replace" | "skip";

/** `DepositPreviewItemDTO` — one resolved target of a `previewDeposit` dry-run: the vault path the dropped
 *  item WOULD land at, its size in bytes (a free stat from the placement walk — the pre-flight quota gate
 *  prices the deposit off these, so a folder deposit is gated as precisely as a loose file; 0 when unknown),
 *  and whether a live row already sits there (a collision to prompt on). */
export interface DepositPreviewItem {
  relativePath: string;
  size: number;
  exists: boolean;
  /** The {@link ExcludeSuggestion} id that WOULD have skipped this item, had the user turned that pack on
   *  — `null` for everything we'd archive anyway (the normal case). This is what lets the app total up
   *  "3.2 GB of this drop is build output" and ask BEFORE uploading, the only moment it's still free. */
  suggestedPack: string | null;
}

/** `ExcludeSuggestionDTO` — one opt-in exclude pack (`listExcludeSuggestions`). The daemon is the SSOT for
 *  the catalogue exactly as it is for the seeded defaults; the app never keeps its own copy.
 *
 *  A pack is junk only IN CONTEXT — a developer's `build/` regenerates in seconds, a woodworker's `build/`
 *  is photos of a workbench — which is why these ship off and are offered rather than seeded. Whether a
 *  pack is "on" is DERIVED (are its patterns in `listExcludes`?), never stored, so there's no second
 *  source of truth to drift from the list the user actually edits. */
export interface ExcludeSuggestion {
  /** Stable wire id (`dev`, `vms`, …). Never shown to a user. */
  id: string;
  title: string;
  /** Why it's usually safe to skip — one sentence, and the whole basis for the user's decision. */
  detail: string;
  patterns: string[];
}

/** `StatusDTO` — the daemon snapshot. `permanentlyFailedBlobs > 0` ⇒ a config/logic fault to fix. */
export interface Status {
  /** Whether the daemon holds a session (see `UserSession`). When false every other field is the
   * empty/zero truth for a signed-out daemon — there is no vault to report on, and the daemon will refuse
   * any command that would touch one. */
  signedIn: boolean;
  filesTotal: number;
  filesArchived: number;
  blobsVerified: number;
  running: boolean;
  permanentlyFailedBlobs: number;
  sources: Source[];
  /** Total bytes stored in S3 under this identity's own prefix — a live listing, so it is the figure the
   * storage quota is actually enforced against. Null when signed out, and ALSO when the listing itself
   * failed or was too slow: it is the one field here backed by a network call, and the daemon degrades it
   * rather than failing the whole snapshot (see `getStatus` in `DaemonService.swift`). So a null here does
   * not imply an empty vault — pair it with `signedIn` before showing it as a figure. */
  bytesStored: number | null;
  /** How long in-flight work may go untouched before the app must stop calling it live — from THIS daemon's
   * real loop cadence, which `COLDSTORE_INTERVAL` makes configurable. The renderer must never restate a
   * threshold of its own, for the same reason {@link RestoreRow.typicalWait} comes from the party that picks
   * the tier: only the daemon knows how often it promised to look.
   *
   * On the SNAPSHOT rather than on each row, because it is one fact about the daemon and BOTH halves of the
   * app ask it — a stalled download and an unattended upload measure silence the same way. */
  staleAfterSeconds: number;
}

/**
 * Where one requested transfer stands. The daemon's `RestoreState` (`Models.swift`) is the SSOT; this is
 * its wire mirror.
 *
 * The distinction the app exists to show honestly: for the ~48 hours a Deep Archive thaw takes, **nothing
 * is transferring**. Deep storage is waking up. So that wait is `pending`, and `transferring` means one
 * thing only — bytes are moving right now. (Until 2026-07-27 the app called the entire thaw "Transferring",
 * so a user watched a transfer report no progress for two days.)
 *
 * `needsAuthorization` is the paid-retrieval hard gate (root `RETRIEVAL.md`): on a signed-in (multi-user)
 * daemon the blobs are frozen and the daemon has no right to thaw them — only the account backend does,
 * and only for a restore that's paid for or inside the free monthly allowance. It is NOT an error; it means
 * the app owes a quote, not a wait.
 */
export type RestoreState =
  | "needsAuthorization"
  | "pending"
  | "transferring"
  | "saved"
  | "canceled"
  | "failed";

/** Is this transfer still working (or waiting on us)? What the Transfers page files under "In progress"
 * and what the sidebar badge counts. Mirrors `RestoreState.isActive` in `Models.swift` — the Swift side is
 * the SSOT, this is its mirror, and both are exhaustive over the same six states.
 *
 * A `Set<RestoreState>` rather than an array + `.includes`, because the array form needs a cast to
 * `readonly string[]` to accept a `RestoreState` — and a cast here would be load-bearing for what the app
 * treats as live work (PILLAR4: type-casting only as a last resort). This needs none. */
const ACTIVE_RESTORE_STATES: ReadonlySet<RestoreState> = new Set([
  "needsAuthorization",
  "pending",
  "transferring",
]);

export const isActiveRestore = (s: RestoreState): boolean => ACTIVE_RESTORE_STATES.has(s);

/** Why a `pending` transfer has stopped being a wait anyone can vouch for. Three distinguishable causes,
 * because the app says something different about each — but one predicate, because every surface has to
 * agree on *whether* a transfer is going nowhere. */
export type RestoreStall =
  /** No pass has ever touched it. */
  | "neverChecked"
  /** Not stepped within the daemon's own {@link Status.staleAfterSeconds}. */
  | "unchecked"
  /** Actively stepped, but run to {@link OVERDUE_MULTIPLE}× the estimated wait and still frozen. */
  | "overdue";

/** How far past the estimate a thaw may run before "taking longer than usual" stops being a fair reading of
 * it. Bulk retrieval overruns ~48 hours routinely; it does not overrun by days. (The *staleness* threshold
 * is NOT a constant here — it's a fact about the daemon's own cadence and arrives per-row.) */
const OVERDUE_MULTIPLE = 2;

/**
 * Has this transfer stopped moving on its own? `null` when it's fine — counting down, over the estimate but
 * still being watched, or in a state that isn't waiting on a thaw at all.
 *
 * Lives here, beside {@link isActiveRestore}, rather than in the page that first needed it, because more
 * than one surface answers to it: the Downloads row's copy and its "Ask again" button, and the file tree's
 * status overlay. Two definitions of "stuck" that could drift is the same class of bug as the two duration
 * formatters and the daemon's deleted rate card — one question, one answer.
 */
export const restoreStall = (
  r: RestoreRow,
  now: number,
  /** The daemon's own window ({@link Status.staleAfterSeconds}). `Infinity` when there is no snapshot to
   * read it from — with no idea how often the daemon promised to look, silence proves nothing, so nothing
   * is called stale. */
  staleAfterSeconds: number,
): RestoreStall | null => {
  if (r.state !== "pending") return null;
  if (r.lastStepAt === null) return "neverChecked";
  // Freshness first: we can't call a thaw overdue on evidence we haven't gathered.
  if (now - r.lastStepAt > staleAfterSeconds) return "unchecked";
  if (now - r.requestedAt > r.typicalWaitSeconds * OVERDUE_MULTIPLE) return "overdue";
  return null;
};

/**
 * One requested transfer, straight from the daemon's `restores` journal table.
 *
 * Journal-backed rather than folded from events in the renderer, because the renderer was the wrong owner
 * in three ways that were each a real bug: the transfer vanished on sign-out, vanished on restart, and
 * couldn't progress while the app was closed — though the request dialog promises exactly that. Read this
 * list; never accumulate a parallel copy from event fragments.
 */
export interface RestoreRow {
  /** Stable transfer id — the handle for cancel/resume/forget. */
  id: string;
  /** The journal file this brings back. */
  fileId: string;
  /** The file's CURRENT vault path (resolved daemon-side; a file can be renamed mid-transfer). Falls back
   * to the destination's basename if the vault copy was since deleted, so history never goes nameless. */
  relativePath: string;
  /** Absolute destination on this Mac, chosen per-request. */
  out: string;
  state: RestoreState;
  tier: string;
  /** The backend retrieval job that authorized this thaw — what was quoted and paid. Null in dogfood mode. */
  jobId: string | null;
  /** Plaintext bytes coming back. */
  bytes: number;
  /** Unix seconds. */
  requestedAt: number;
  /** Unix seconds the thaw was first seen READY — when the 5-day download window opened. Null until then. */
  readyAt: number | null;
  /** Unix seconds the daemon last ASKED S3 about this transfer — stamped every pass, whatever the answer.
   * Null on a transfer no pass has touched yet (and on rows that predate the column).
   *
   * This is what makes {@link RestoreState} `pending` checkable instead of merely believable. `pending`
   * claims a thaw is running *right now*; paired with `requestedAt` alone, a row nothing had looked at since
   * July rendered exactly like a healthy 48-hour wait, and the page cheerfully said "still waiting" forever.
   * Read it with `error`: this says when we last tried, `error` says how it went. */
  lastStepAt: number | null;
  completedAt: number | null;
  error: string | null;
  /** How long the thaw takes, in plain words, from the tier we actually quote at. The app must never
   * invent its own wait — only the party that picks the tier can state it honestly. */
  typicalWait: string;
  /** The same wait in seconds — the machine-readable half of {@link typicalWait}, from the same tier, so
   * the two can never disagree. `requestedAt + typicalWaitSeconds` is the estimated ready-by instant, which
   * is what lets a waiting row count down instead of restating "~48 hours" for two days.
   *
   * An ESTIMATE, not a deadline: a thaw can land early or run over, so a row can still be `pending` after
   * this elapses. Say "taking longer than usual" then — never a negative countdown. */
  typicalWaitSeconds: number;
  /** Unix seconds this thawed copy stops being free to download (`readyAt` + the 5-day thaw window).
   * Null until the thaw is ready, because the window hasn't opened and any date would be invented. */
  freeUntil: number | null;
  /** True ⇒ "Resume" costs nothing: the blobs this job already paid to thaw are still warm. Decided by the
   * daemon (`RestoreRow.isResumable`), never by the renderer — getting it wrong charges someone twice. */
  resumable: boolean;
}

/** `AuthDTO` — `authenticate`'s result: the Cognito identity id this daemon's uploads are now scoped
 *  under (`blobs/<identityId>`), the per-user prefix the IAM role's policy variable matches against. */
export interface Auth {
  ok: boolean;
  identityId: string;
}

/** The zero-knowledge key-blob — MK wrapped under a recovery-code-derived Argon2id
 * key, ciphertexts + salts as base64. Exactly the shape the account backend stores (blind) and the
 * `unlockVaultWithRecoveryCode` command reconstructs. The password slot is filled but unused (passwordless). */
export interface KeyBlobFields {
  wrappedMKPassword: string;
  saltPassword: string;
  wrappedMKRecovery: string;
  saltRecovery: string;
  opsLimit: number;
  memLimit: number;
}

/** `mintVault`'s result (signup): the key-blob to store server-side + the one-time recovery code to show
 * ONCE + the freshly-minted MasterKey (base64) for the app to escrow per-device. All local-socket only. */
export interface MintVault extends KeyBlobFields {
  ok: boolean;
  recoveryCode: string;
  masterKey: string;
}

/** `unlockVaultWithRecoveryCode`'s result: the unlocked MasterKey (base64) for the app to escrow so a
 * new device won't need the recovery code again. */
export interface UnlockVault {
  ok: boolean;
  masterKey: string;
}

/**
 * Typed command surface — method → {params, result}. Mirrors the `switch` in `DaemonService.handle`.
 * Params with no entries take no params; optional keys (`tier`, `days`) match the Swift defaults.
 */
export interface Commands {
  ping: { params: Record<string, never>; result: Ack };
  getStatus: { params: Record<string, never>; result: Status };
  listSources: { params: Record<string, never>; result: Source[] };
  listFiles: { params: Record<string, never>; result: ListedFile[] };
  /** Register a watched folder. `mountPath` is the vault-relative destination its tree lands under in My
   * Files; omit/empty → the daemon defaults to the source's basename (never root, to keep mounts namespaced). */
  addSource: { params: { path: string; mountPath?: string }; result: Ack };
  removeSource: { params: { id: string }; result: Ack };
  /** The gitignore-style exclude patterns the scan/deposit skips (the daemon is the SSOT; defaults seeded
   * on first run). `addExclude`/`removeExclude` mutate the registry and emit `excludesChanged`. */
  listExcludes: { params: Record<string, never>; result: string[] };
  /** The opt-in exclude packs we OFFER but never seed (see {@link ExcludeSuggestion}). A static catalogue,
   * so it answers the same signed-in or not. Read by both surfaces that offer them: Settings' suggestion
   * shelf and the deposit-time prompt. */
  listExcludeSuggestions: { params: Record<string, never>; result: ExcludeSuggestion[] };
  addExclude: { params: { pattern: string }; result: Ack };
  removeExclude: { params: { pattern: string }; result: Ack };
  /** Ad-hoc drop-to-upload: archive these paths once under `dest` (a vault-relative folder; "" = root),
   * without registering a watched source. `src` is newline-joined absolute paths. Fire-and-forget — the
   * reply just acks; progress/outcome arrive as runStarted/fileArchived/blobFailed/runFinished events. */
  /** `excludeExtra` (newline-joined patterns) is honored for THIS DEPOSIT ONLY — the user's "skip those,
   * just this once" at the drop-time suggestion prompt. Deliberately not the excludes registry: *not this
   * time* and *never again* are different answers, and offering the first must never quietly do the
   * second. "Remember this" is a separate `addExclude` the app issues alongside. */
  deposit: { params: { src: string; dest: string; conflicts?: string; excludeExtra?: string }; result: Ack };
  /** Explicit photo deposit (the photo analogue of `deposit`): archive these PICKED Photos-library assets
   * once under `dest` (a vault-relative folder; "" = root). `assetIds` is newline-joined Photos
   * localIdentifiers — only the picked assets are read, never the whole library. Mac-only (PhotoKit); off
   * macOS the daemon emits an `error` event. Fire-and-forget — the reply acks, progress/outcome arrive as
   * runStarted/fileArchived/blobFailed/runFinished events (exactly like `deposit`). */
  depositPhotos: { params: { assetIds: string; dest: string; conflicts?: string }; result: Ack };
  /** Dry-run a deposit's PLACEMENT (no upload): resolve where each dropped file / picked photo would land
   * (same logic as `deposit`/`depositPhotos`) and report which targets already exist — the collisions the UI
   * prompts on (Keep Both / Replace / Skip). Pass `src` (newline-joined absolute paths) OR `assetIds`
   * (newline-joined Photos localIdentifiers), plus `dest`. The chosen resolutions ride back as the
   * `conflicts` param on `deposit`/`depositPhotos` (a JSON map of vault relativePath → policy). */
  previewDeposit: {
    params: { dest: string; src?: string; assetIds?: string };
    result: DepositPreviewItem[];
  };
  /** Reorganize: relocate the subtree at `from` → `to` — a file/folder MOVE or RENAME (a rename is just a
   * move to a sibling path). A cheap journal `relativePath` edit (no S3, no thaw, the blob never moves);
   * the stable file id is unchanged. Emits `filesChanged`. */
  movePath: { params: { from: string; to: string }; result: Ack };
  /** Anchor an empty folder so it survives a reload: writes a path-only journal marker (no S3, no thaw).
   * The tree is derived from file paths, so an empty folder otherwise has nothing to imply it. Idempotent
   * on `path` (a no-op if a real file already sits there). Emits `filesChanged`. */
  createFolder: { params: { path: string }; result: Ack };
  /** Would a scan find this path again tomorrow — i.e. is it still on disk inside a live watched folder?
   * Ask BEFORE deleting, so the confirm dialog can say so up front and offer `alsoIgnore` in the same
   * step. Answered by looking at the filesystem, not by guessing from source config. */
  pathIsWatched: { params: { path: string }; result: { isWatched: boolean } };
  /** Delete (tombstone) the subtree at `path` (file or folder): it drops from `listFiles` immediately and
   * a rescan can never resurrect it — only an explicit re-deposit can. Its bytes are reclaimed once every
   * file sharing their blob is deleted; the space returns when Deep Archive's 180-day minimum on those
   * bytes runs out (immediately, if they're already past it).
   *
   * `alsoIgnore` adds the watched-folder exclude in the same call — the second half of the one-button fix
   * for "this is in a watched folder". Without it a deleted file stays permanently un-backed-up with
   * nothing saying why. Emits `filesChanged`. */
  deletePath: {
    /** `alsoIgnore` is `"true"`/`"false"`, NOT a boolean — the control wire is `[String:String]` (see the
     * note on `opsLimit`/`memLimit` below). A JSON bool fails `ControlRequest` decoding outright, and the
     * daemon's malformed-request reply carries `id: 0`, which no client request can ever match — so the
     * call hangs to its timeout with no error. `ParamsArg` now rejects non-string params at compile time. */
    params: { path: string; alsoIgnore?: "true" | "false" };
    result: { ok: boolean; ignored: boolean };
  };
  /** What restoring these files would take to serve — the input to the backend's `POST /retrieval/quote`
   * (root RETRIEVAL.md). Ask this BEFORE showing any price: a restore is billed on the whole BLOBS that
   * must be thawed (packed, so one photo can drag a 256 MiB blob with it) plus the bytes that come back —
   * neither of which the renderer can work out. `blobKeys` is deduped (one thaw per blob, however many
   * files ride in it). Read-only: touches the journal, never S3. */
  restorePlan: {
    params: { files: string };
    result: { blobKeys: string[]; egressBytes: number };
  };
  /** Every transfer this Mac has requested, newest first — active and history in one list. The Transfers
   * page reads this; it is the SSOT. Empty when signed out (transfers are vault data). */
  listRestores: { params: Record<string, never>; result: RestoreRow[] };
  /** Start a transfer: record it durably, then take the first step. Call this only once the restore is
   * AUTHORIZED (paid, or free under the allowance) — `jobId` links the row to what was paid. The daemon's
   * run loop drives it from here, so it keeps going with the app closed. A new request for a file
   * SUPERSEDES any transfer of it still in flight (the old row is stopped), so a re-ask can't leave a dead
   * row padding the count.
   *
   * There is no `tier`: bulk is the only tier the backend quotes at, so letting a caller name a faster one
   * would spend money nobody charged for (root RETRIEVAL.md).
   *
   * Every one of these commands answers with the WHOLE list, so the caller never has to reconcile a
   * mutation against its own copy — it just adopts the reply. */
  requestRestore: {
    params: { file: string; out: string; jobId?: string };
    result: RestoreRow[];
  };
  /** Stop a transfer. This stops the COPY, not the thaw: a Glacier retrieval can't be called back and the
   * money is already spent. Honest only because `resumeRestore` is free while the 5-day window lasts — the
   * app's copy must say so and must not imply a refund. */
  cancelRestore: { params: { id: string }; result: RestoreRow[] };
  /** Pick a stopped/failed transfer back up. Free while `resumable` is true. If the window has lapsed the
   * next pass finds the blobs cold and the row lands on `needsAuthorization` — the truthful answer, which
   * routes the user to a fresh quote rather than a wait that would never end. */
  resumeRestore: { params: { id: string }; result: RestoreRow[] };
  /** Clear a FINISHED transfer from history. Forgets the record, not the copy on disk. Rejects an active
   * transfer — stop it first, or the run loop would keep driving something the user thinks is dismissed. */
  forgetRestore: { params: { id: string }; result: RestoreRow[] };
  triggerNow: { params: Record<string, never>; result: Ack };
  /** Stop the deposit/scan in flight. `ok` = there was one to stop. Cooperative and prompt (the daemon
   * notices within a frame and cancels its in-flight part uploads); the outcome arrives as `runFinished`
   * carrying `filesStopped`, never as an `error`. Nothing already landed is undone — completed blobs stay
   * archived, and a half-uploaded blob keeps its multipart upload on S3 so a later run resumes it
   * part-for-part. The unfinished files are marked `failed` in the journal with a "stopped" reason, so
   * their rows are honest until the next pass (watched folder) or re-drop (ad-hoc deposit) picks them up.
   * Stops the run IN FLIGHT only: a deposit queued behind it (a second drop) is untouched and starts as
   * soon as this one ends — the banner comes back with its own Stop. */
  cancelRun: { params: Record<string, never>; result: Ack };
  /** Per-source pause/resume — stop/resume auto-syncing one watched folder (it stays registered).
   * Persisted in the journal; both emit `sourcesChanged` so the UI refetches. (There is no global pause.) */
  pauseSource: { params: { id: string }; result: Ack };
  resumeSource: { params: { id: string }; result: Ack };
  /** Exchange a Cognito User Pool ID token for real per-user AWS credentials — every upload/restore after
   * this signs as the returned identity, whose uploads land under `blobs/<identityId>`. Errors on a daemon
   * with no Cognito identity pool configured (today's single-operator dogfood mode). The sign-in UI itself
   * is a later phase; this is just the wire contract. */
  authenticate: { params: { idToken: string }; result: Auth };
  /** Sign-out counterpart to `authenticate` (the credentials half — `lockVault` is the key half): the
   * daemon drops its cached AWS credentials + vault prefix NOW instead of holding them for the remainder
   * of the ~1h STS expiry. Errors on a daemon with no Cognito identity pool configured (dogfood mode —
   * which never calls it: the auth UI doesn't exist there). */
  deauthenticate: { params: Record<string, never>; result: Ack };
  /** Push the signed-in account's storage quota (bytes) to the daemon so `UploadEngine` can enforce the
   * ceiling on every run — including the periodic auto-run the renderer never sees. The app owns the
   * `/entitlement` fetch; the daemon can't reach the account backend, so it learns the number from here.
   * Sent right after `authenticate` and whenever the entitlement changes. OMIT `quotaBytes` (or send it
   * empty) to CLEAR enforcement — dogfood mode, or a subscriber whose plan the app couldn't resolve — which
   * fails open, matching the app-side gate. Value is a string on the wire (the daemon re-parses with Int()). */
  setQuota: { params: { quotaBytes?: string }; result: Ack };
  /** Zero-knowledge vault — all multi-user only (error on a dogfood daemon), all
   * carrying key material over the LOCAL control socket, never the network:
   * - `mintVault` (signup): mint MK + one-time recovery code, load it live, return the blob to store +
   *   the code to show once + the MK to escrow. No params.
   * - `unlockVault` (day-to-day): load the app's per-device-cached MK (base64) after a (re)connect.
   * - `unlockVaultWithRecoveryCode` (new device): unwrap MK from the backend's key-blob + the code the
   *   user typed; returns the MK to escrow.
   * - `lockVault` (sign-out): drop the MK; later deposits/restores fail until the next unlock. */
  mintVault: { params: Record<string, never>; result: MintVault };
  /** Fresh one-time recovery code wrapping the session's LIVE MK (vault must be unlocked): the
   * onboarding "didn't finish saving your code" re-show. Same result shape as `mintVault`; the old
   * code is dead once the returned blob is PUT over the server copy. */
  reissueRecoveryCode: { params: Record<string, never>; result: MintVault };
  unlockVault: { params: { masterKey: string }; result: Ack };
  // The control wire is [String:String] (like restore's `days`), so the key-blob's numeric opsLimit/
  // memLimit must go as strings — the daemon re-parses them with Int(...). Sending them as JSON numbers
  // fails the daemon's param decode outright (looks like a wrong code, but the crypto never runs).
  unlockVaultWithRecoveryCode: {
    params: {
      wrappedMKPassword: string;
      saltPassword: string;
      wrappedMKRecovery: string;
      saltRecovery: string;
      opsLimit: string;
      memLimit: string;
      recoveryCode: string;
    };
    result: UnlockVault;
  };
  lockVault: { params: Record<string, never>; result: Ack };
}

export type Method = keyof Commands;

/**
 * Call-args helper: a command whose params object has no fields takes NO argument; any other takes
 * its params object. Drives the variadic signature of both the layer-1 client and the IPC bridge.
 */
export type ParamsArg<M extends Method> =
  Commands[M]["params"] extends Record<string, never>
    ? []
    : [params: Commands[M]["params"] & StringParams];

/**
 * Every param value crosses the socket inside a Swift `[String: String]` (`ControlProtocol.swift`), so a
 * number or boolean doesn't just coerce — it fails the whole `ControlRequest` decode and the command never
 * runs. Intersecting params with this in `ParamsArg` turns that into a compile error at the call site
 * instead of a silent 10-second timeout in front of a user. Numbers/booleans go as strings and the daemon
 * re-parses them (see `opsLimit`/`memLimit`, and `deletePath`'s `alsoIgnore`).
 */
type StringParams = Record<string, string | undefined>;

// ── Events (DaemonEvent call sites) ──────────────────────────────────────────

/**
 * Event name → data shape. Every value arrives as a string. Keys mirror the exact `DaemonEvent`
 * payloads in `DaemonService` (e.g. `runFinished` carries the three count strings it publishes).
 * `sourcesChanged` carries exactly one of `added`/`removed`/`paused`/`resumed` (the id), depending on
 * which command fired it; the controller's response to any of them is to refetch `listSources`.
 */
export interface DaemonEvents {
  runStarted: Record<string, never>;
  fileArchived: { file: string; blob: string };
  /** Determinate per-file upload progress (bytes uploaded / encrypted total), emitted once per 64 MiB
   * part for a solo (large-file) blob. `file` is the journal id, `path` the relativePath — the UI matches
   * a row by either (they diverge for Photos / not-yet-archived drops). */
  uploadProgress: { file: string; path: string; bytes: string; totalBytes: string };
  /** Whole-run aggregate progress — the source for the deposit bar, byte readout, throughput and ETA.
   * Unlike `uploadProgress` (one solo file's own bar), this spans every file and blob in the run, so a
   * deposit of many small batched files shows real progress instead of silence. Emitted on each meaningful
   * tick: run start (with the denominators), each item as it begins, each 64 MiB part, each file linked.
   * All bytes are ENCRYPTED bytes, so `bytesUploaded / bytesTotal` reaches exactly 1. `bytesTotal` can be
   * "0" for a Photos deposit (sizes unknown until streamed) — the UI falls back to file-count progress.
   * `currentPath` is the file currently streaming ("" between items). ETA/throughput are NOT here: the UI
   * derives them by differencing these snapshots over time. */
  runProgress: {
    filesTotal: string;
    bytesTotal: string;
    filesArchived: string;
    bytesUploaded: string;
    currentPath: string;
  };
  /** `blobsFailed` counts FAULTS only. `filesStopped` is how many files a `cancelRun` left un-uploaded —
   * reported apart so the UI says "stopped", not "couldn't upload", about work the user ended on purpose.
   * Absent on the early-abort path (a run that threw before planning). */
  runFinished: { filesArchived: string; filesTotal: string; blobsFailed: string; filesStopped?: string };
  /** A blob that failed to archive this pass. `paths` is the newline-joined relativePaths of the files it
   * batched (named in the failures panel + used to flip their rows); permanent failures are also persisted
   * as a per-file `failed` status in the journal, so the ⚠ survives the next `listFiles` read. */
  blobFailed: { blob: string; kind: "permanent" | "transient" | "overQuota"; message: string; paths: string };
  sourcesChanged: { added?: string; removed?: string; paused?: string; resumed?: string };
  /** The exclude registry changed via add/removeExclude (carries the affected pattern for logging). The
   * controller's response is to re-read `listExcludes`; it also means the *next* scan applies the change. */
  excludesChanged: { added?: string; removed?: string };
  /** The journal tree changed via a reorganize/delete/new-folder (`movePath`/`deletePath`/`createFolder`).
   * Carries the affected path (`moved`+`to`, XOR `deleted`, XOR `created`) for logging; the controller's
   * response is to re-read `listFiles`. */
  filesChanged: { moved?: string; to?: string; deleted?: string; created?: string };
  /** The transfer list moved — re-read `listRestores`. ONE event for the whole list, deliberately: a
   * per-state event carrying a fragment is what invited the renderer to fold its own parallel copy, and
   * that copy is what silently lost an in-flight transfer on sign-out. The journal is the SSOT; this event
   * says only "it changed". */
  restoresChanged: Record<string, never>;
  /** Determinate download progress for ONE `transferring` row: plaintext bytes decrypted and on disk so
   * far, emitted once per ~4 MiB frame while the ranged GET streams. `id` is the RestoreRow id (the key
   * the Transfers page folds by); `totalBytes` is the row's own plaintext size — numerator and denominator
   * count the same thing, so the bar reaches exactly 100%. Ephemeral by design: fold it live for the bar,
   * never persist it or grow rows from it — the row's STATE still comes only from `listRestores`. */
  restoreProgress: { id: string; file: string; bytes: string; totalBytes: string };
  /** A transfer finished and the bytes are on disk. Distinct from `restoresChanged` because a completion
   * is a moment, not a state — it's what a "your copy is ready" notification hangs off. */
  restoreCompleted: { file: string; out: string };
  /** A daemon-side error surfaced to the user as a toast. `code`, when present, marks a KNOWN, actionable
   * failure the UI can offer recovery for — `photosAccessDenied` (the daemon lacks full Photos access →
   * show an "Open Photos settings" button) and `photosNoneResolved` (none of the picked photos could be
   * read). Absent `code` ⇒ a plain message with no action. */
  error: { message: string; code?: "photosAccessDenied" | "photosNoneResolved" };
}

export type DaemonEventName = keyof DaemonEvents;
