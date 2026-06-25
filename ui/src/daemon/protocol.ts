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
}

/** `StatusDTO` — the daemon snapshot. `permanentlyFailedBlobs > 0` ⇒ a config/logic fault to fix. */
export interface Status {
  filesTotal: number;
  filesArchived: number;
  blobsVerified: number;
  paused: boolean;
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

/**
 * Typed command surface — method → {params, result}. Mirrors the `switch` in `DaemonService.handle`.
 * Params with no entries take no params; optional keys (`tier`, `days`) match the Swift defaults.
 */
export interface Commands {
  ping: { params: Record<string, never>; result: Ack };
  getStatus: { params: Record<string, never>; result: Status };
  listSources: { params: Record<string, never>; result: Source[] };
  listFiles: { params: Record<string, never>; result: ListedFile[] };
  addSource: { params: { path: string }; result: Ack };
  removeSource: { params: { id: string }; result: Ack };
  /** Ad-hoc drop-to-upload: archive these paths once under `dest` (a vault-relative folder; "" = root),
   * without registering a watched source. `src` is newline-joined absolute paths. Fire-and-forget — the
   * reply just acks; progress/outcome arrive as runStarted/fileArchived/blobFailed/runFinished events. */
  deposit: { params: { src: string; dest: string }; result: Ack };
  /** Reorganize: relocate the subtree at `from` → `to` — a file/folder MOVE or RENAME (a rename is just a
   * move to a sibling path). A cheap journal `relativePath` edit (no S3, no thaw, the blob never moves);
   * the stable file id is unchanged. Emits `filesChanged`. */
  movePath: { params: { from: string; to: string }; result: Ack };
  /** Delete (tombstone) the subtree at `path` (file or folder): it drops from `listFiles`, but the row +
   * blob mapping are kept (byte reclaim is a deferred repack/GC — deep storage has a 180-day minimum).
   * Emits `filesChanged`. */
  deletePath: { params: { path: string }; result: Ack };
  restore: {
    params: { file: string; out: string; tier?: string; days?: string };
    result: RestoreStep;
  };
  triggerNow: { params: Record<string, never>; result: Ack };
  pause: { params: Record<string, never>; result: Ack };
  resume: { params: Record<string, never>; result: Ack };
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
 * `sourcesChanged` carries `added` XOR `removed` depending on which command fired it.
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
  sourcesChanged: { added?: string; removed?: string };
  /** The journal tree changed via a reorganize/delete (`movePath`/`deletePath`). Carries the affected path
   * (`moved`+`to`, XOR `deleted`) for logging; the controller's response is to re-read `listFiles`. */
  filesChanged: { moved?: string; to?: string; deleted?: string };
  restoreRequested: { file: string; tier: string };
  restoreInProgress: { file: string };
  restoreCompleted: { file: string; out: string };
  paused: Record<string, never>;
  resumed: Record<string, never>;
  error: { message: string };
}

export type DaemonEventName = keyof DaemonEvents;
