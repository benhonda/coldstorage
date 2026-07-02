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
}

/**
 * `FileDTO` — one browsable file from `listFiles`: the journal IS the tree SSOT (paths/sizes/status),
 * NOT S3 keys. A pure metadata read — no R2, no thaw. `status` is the RAW journal `FileStatus`
 * (`discovered | planned | staging | uploading | verifying | archived | failed`); the renderer coarsens
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
}

/** How a deposit resolves a name-collision (the Finder-style prompt). Mirrors Swift `ConflictPolicy`.
 *  `keepBoth` archives the incoming item under a fresh name; `replace` overwrites the existing file;
 *  `skip` doesn't deposit it. */
export type ConflictPolicy = "keepBoth" | "replace" | "skip";

/** `DepositPreviewItemDTO` — one resolved target of a `previewDeposit` dry-run: the vault path the dropped
 *  item WOULD land at, and whether a live row already sits there (a collision to prompt on). */
export interface DepositPreviewItem {
  relativePath: string;
  exists: boolean;
}

/** `StatusDTO` — the daemon snapshot. `permanentlyFailedBlobs > 0` ⇒ a config/logic fault to fix. */
export interface Status {
  filesTotal: number;
  filesArchived: number;
  blobsVerified: number;
  running: boolean;
  permanentlyFailedBlobs: number;
  sources: Source[];
}

/**
 * `RestoreDTO` — one idempotent restore step's outcome. Re-issue `restore` until `state==="restored"`.
 * `out` is set only when bytes landed; `tier`/`typicalWait` only while thawing (for the quoted wait).
 */
export interface RestoreStep {
  file: string;
  state: "restored" | "thawRequested" | "thawInProgress";
  out: string | null;
  tier: string | null;
  typicalWait: string | null;
}

/** `TierQuoteDTO` — one Glacier retrieval tier's per-GB fee + typical wait (SSOT: the daemon's `RestoreTier`). */
export interface TierQuote {
  tier: string;
  usdPerGB: number;
  typicalWait: string;
}

/**
 * `PricingDTO` — the storage/retrieval rate card the UI quotes cost+fee from (the daemon is the SSOT;
 * `note` is the estimate disclaimer to show beside any figure). All figures are USD list prices. Static
 * estimate — the UI does the trivial bytes × rate math, the daemon owns the numbers. See `getPricing`.
 */
export interface Pricing {
  storageUsdPerGBMonth: number;
  retrieval: TierQuote[];
  note: string;
}

/** `AuthDTO` — `authenticate`'s result: the Cognito identity id this daemon's uploads are now scoped
 *  under (`blobs/<identityId>`), the per-user prefix the IAM role's policy variable matches against. */
export interface Auth {
  ok: boolean;
  identityId: string;
}

/** The zero-knowledge key-blob (PROD.md Phase 5b) — MK wrapped under a recovery-code-derived Argon2id
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
  /** The storage/retrieval rate card (SSOT) the UI quotes cost+fee from. Static — fetched once on connect. */
  getPricing: { params: Record<string, never>; result: Pricing };
  /** Register a watched folder. `mountPath` is the vault-relative destination its tree lands under in My
   * Files; omit/empty → the daemon defaults to the source's basename (never root, to keep mounts namespaced). */
  addSource: { params: { path: string; mountPath?: string }; result: Ack };
  removeSource: { params: { id: string }; result: Ack };
  /** The gitignore-style exclude patterns the scan/deposit skips (the daemon is the SSOT; defaults seeded
   * on first run). `addExclude`/`removeExclude` mutate the registry and emit `excludesChanged`. */
  listExcludes: { params: Record<string, never>; result: string[] };
  addExclude: { params: { pattern: string }; result: Ack };
  removeExclude: { params: { pattern: string }; result: Ack };
  /** Ad-hoc drop-to-upload: archive these paths once under `dest` (a vault-relative folder; "" = root),
   * without registering a watched source. `src` is newline-joined absolute paths. Fire-and-forget — the
   * reply just acks; progress/outcome arrive as runStarted/fileArchived/blobFailed/runFinished events. */
  deposit: { params: { src: string; dest: string; conflicts?: string }; result: Ack };
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
  /** Delete (tombstone) the subtree at `path` (file or folder): it drops from `listFiles`, but the row +
   * blob mapping are kept (byte reclaim is a deferred repack/GC — deep storage has a 180-day minimum).
   * Emits `filesChanged`. */
  deletePath: { params: { path: string }; result: Ack };
  restore: {
    params: { file: string; out: string; tier?: string; days?: string };
    result: RestoreStep;
  };
  triggerNow: { params: Record<string, never>; result: Ack };
  /** Per-source pause/resume — stop/resume auto-syncing one watched folder (it stays registered).
   * Persisted in the journal; both emit `sourcesChanged` so the UI refetches. (There is no global pause.) */
  pauseSource: { params: { id: string }; result: Ack };
  resumeSource: { params: { id: string }; result: Ack };
  /** Exchange a Cognito User Pool ID token for real per-user AWS credentials — every upload/restore after
   * this signs as the returned identity, whose uploads land under `blobs/<identityId>`. Errors on a daemon
   * with no Cognito identity pool configured (today's single-operator dogfood mode). The sign-in UI itself
   * is a later phase (PROD.md Phase 5); this is just the wire contract. */
  authenticate: { params: { idToken: string }; result: Auth };
  /** Zero-knowledge vault (PROD.md Phase 5b) — all multi-user only (error on a dogfood daemon), all
   * carrying key material over the LOCAL control socket, never the network:
   * - `mintVault` (signup): mint MK + one-time recovery code, load it live, return the blob to store +
   *   the code to show once + the MK to escrow. No params.
   * - `unlockVault` (day-to-day): load the app's per-device-cached MK (base64) after a (re)connect.
   * - `unlockVaultWithRecoveryCode` (new device): unwrap MK from the backend's key-blob + the code the
   *   user typed; returns the MK to escrow.
   * - `lockVault` (sign-out): drop the MK; later deposits/restores fail until the next unlock. */
  mintVault: { params: Record<string, never>; result: MintVault };
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
  Commands[M]["params"] extends Record<string, never> ? [] : [params: Commands[M]["params"]];

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
  runFinished: { filesArchived: string; filesTotal: string; blobsFailed: string };
  /** A blob that failed to archive this pass. `paths` is the newline-joined relativePaths of the files it
   * batched (named in the failures panel + used to flip their rows); permanent failures are also persisted
   * as a per-file `failed` status in the journal, so the ⚠ survives the next `listFiles` read. */
  blobFailed: { blob: string; kind: "permanent" | "transient"; message: string; paths: string };
  sourcesChanged: { added?: string; removed?: string; paused?: string; resumed?: string };
  /** The exclude registry changed via add/removeExclude (carries the affected pattern for logging). The
   * controller's response is to re-read `listExcludes`; it also means the *next* scan applies the change. */
  excludesChanged: { added?: string; removed?: string };
  /** The journal tree changed via a reorganize/delete/new-folder (`movePath`/`deletePath`/`createFolder`).
   * Carries the affected path (`moved`+`to`, XOR `deleted`, XOR `created`) for logging; the controller's
   * response is to re-read `listFiles`. */
  filesChanged: { moved?: string; to?: string; deleted?: string; created?: string };
  restoreRequested: { file: string; tier: string };
  restoreInProgress: { file: string };
  restoreCompleted: { file: string; out: string };
  /** A daemon-side error surfaced to the user as a toast. `code`, when present, marks a KNOWN, actionable
   * failure the UI can offer recovery for — `photosAccessDenied` (the daemon lacks full Photos access →
   * show an "Open Photos settings" button) and `photosNoneResolved` (none of the picked photos could be
   * read). Absent `code` ⇒ a plain message with no action. */
  error: { message: string; code?: "photosAccessDenied" | "photosNoneResolved" };
}

export type DaemonEventName = keyof DaemonEvents;
