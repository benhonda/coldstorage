/**
 * The event-stream → app-state fold (layer 2). A PURE reducer: `(state, action) → state`, no I/O — so
 * it's unit-testable headless (see reducer.test.ts) and React just binds to the store that wraps it.
 *
 * `status` is the authoritative snapshot (from `getStatus`/`listSources`); `run`, `failures`,
 * `restores`, `lastError` are folded live from pushed events. Daemon event values arrive as STRINGS
 * (the `[String:String]` wire) — numbers are parsed here, the one place that knows the wire shape.
 */
import type {
  AuthStatus,
  ConnectionState,
  DaemonEventName,
  DaemonEvents,
  EntitlementStatus,
  ListedFile,
  Source,
  Status,
  UpdateStatus,
  VaultStatus,
} from "../../../shared/ipc.ts";

/** Live progress of the current/most-recent run, folded from runStarted/fileArchived/runFinished. */
export interface RunProgress {
  active: boolean;
  /** Files archived so far (live count while active; final total when finished). */
  filesArchived: number;
  /** Total in scope. Known from the FIRST `runProgress` tick now (the daemon reports it at plan time), not
   * only at `runFinished` — which is what lets the bar have a denominator the instant a deposit starts. */
  filesTotal: number | null;
  /** Encrypted bytes shipped so far this run, across every file and blob — the aggregate the bar is drawn
   * from. Advances for batched small files too, not just solo large ones. */
  bytesUploaded: number;
  /** Encrypted bytes the whole run will ship. `null` when unknown — a Photos deposit, whose sizes aren't
   * known until streamed; the UI shows file-count progress there instead of a byte bar. */
  bytesTotal: number | null;
  /** The file currently streaming — the "now uploading …" line. `null` between files / when idle. */
  currentPath: string | null;
  /** Recent `(timestamp, bytesUploaded)` samples, bounded — the raw signal `throughput`/`etaSeconds` smooth
   * into a rate and a time estimate. Kept in state (not recomputed) so the math stays pure + testable. */
  samples: { t: number; bytes: number }[];
  /** Blobs that failed this run — known only at `runFinished`. */
  blobsFailed: number | null;
  /** Most-recent-first, capped — for a live "now archiving…" feed. */
  recent: { file: string; blob: string }[];
  /** Live determinate upload progress, keyed by the daemon file id. Each entry carries the file's `path`
   * too, so the browser can match either a journal row (by id) or an optimistic drop row (by path). Only
   * large (solo-blob) files appear here; small batched files flip to archived too fast to bother. Cleared
   * at `runFinished`; an entry is dropped as its file archives. */
  uploadProgress: Record<string, { path: string; uploaded: number; total: number }>;
}

export interface BlobFailure {
  blob: string;
  /** `overQuota` = refused because it would cross the storage quota (the daemon's `UploadEngine` ceiling).
   * Not a fault and not permanent — it uploads once there's room (freed space / a bigger plan) — but from
   * the user's view it's "stuck", so it surfaces alongside permanent failures. */
  kind: "permanent" | "transient" | "overQuota";
  message: string;
  /** relativePaths of the files in the failed blob — for naming them in the panel + flipping their rows. */
  files: string[];
}

/** One file's restore progress, folded from the restore* events (idempotent, re-issued by the UI). */
export interface RestoreActivity {
  file: string;
  state: "requested" | "inProgress" | "completed";
  tier: string | null;
  out: string | null;
}

export interface AppState {
  /** True until the first status batch (connection + auth + vault) has arrived from main. Gates the whole
   * app on a neutral "checking…" screen so we never flash the shell or the wrong gate before we know
   * whether the user is signed in. Cleared once by the controller's first-paint fetch. */
  initializing: boolean;
  connection: ConnectionState;
  /** Sign-in status (Phase 5), pushed from main. Starts unconfigured — dogfood mode until the first
   * push says otherwise, so the auth gate never flashes for a dogfood install. */
  auth: AuthStatus;
  /** Zero-knowledge vault status (Phase 5b), pushed from main. Starts locked; only gates the app once
   * the user is signed in (a dogfood install never signs in, so it never matters). */
  vault: VaultStatus;
  /** Subscription entitlement (Phase 5c), pushed from main. Gates deposits (not browse/restore). */
  entitlement: EntitlementStatus;
  /** Auto-update status (Phase 6), pushed from main. Packaged app only — stays `idle` in dev. Drives the
   * quiet "Restart to update" affordance when a newer signed build has downloaded. */
  update: UpdateStatus;
  status: Status | null;
  /** The browsable tree, straight from the daemon's `listFiles` (journal-backed). Raw wire shape —
   * the file-browser maps it to its own model. Empty until the first read lands. */
  files: ListedFile[];
  /** Exclude patterns (daemon `listExcludes`) — Settings' "Don't back up" chips. Authoritative; the
   * daemon seeds defaults on first run + applies them at scan time. */
  excludes: string[];
  run: RunProgress | null;
  failures: BlobFailure[];
  /** Keyed by file id. */
  restores: Record<string, RestoreActivity>;
  lastError: string | null;
  /** The `code` of the most recent daemon `error` (or null) — drives a recovery action on the toast, e.g.
   * `photosAccessDenied` → an "Open Photos settings" button. Cleared (→ null) by any error without a code. */
  lastErrorCode: DaemonEvents["error"]["code"] | null;
}

export const initialState: AppState = {
  initializing: true,
  connection: "connecting",
  auth: { configured: false, state: "signedOut", email: null, error: null, emailAvailable: false },
  vault: { state: "locked", recoveryCode: null, error: null },
  entitlement: { known: false, active: false, checkingOut: false, quotaBytes: null, error: null },
  update: { state: "idle", version: null, percent: null, error: null },
  status: null,
  files: [],
  excludes: [],
  run: null,
  failures: [],
  restores: {},
  lastError: null,
  lastErrorCode: null,
};

/** Distributive event action — keeps each event name correlated with its own data shape (for the
 * reducer's `switch`, which narrows `data` per `name`). */
type EventAction = {
  [E in DaemonEventName]: { type: "event"; name: E; data: DaemonEvents[E] };
}[DaemonEventName];

export type Action =
  | { type: "connection"; state: ConnectionState }
  | { type: "initialized" }
  | { type: "authChanged"; auth: AuthStatus }
  | { type: "vaultChanged"; vault: VaultStatus }
  | { type: "entitlementChanged"; entitlement: EntitlementStatus }
  | { type: "updateChanged"; update: UpdateStatus }
  | { type: "statusLoaded"; status: Status }
  | { type: "sourcesLoaded"; sources: Source[] }
  | { type: "filesLoaded"; files: ListedFile[] }
  | { type: "excludesLoaded"; excludes: string[] }
  | EventAction;

/**
 * Build a correlated event action from a `<E>`-typed (name, data) pair. The lone cast in this layer:
 * TS can't verify a generic `{name: E, data: DaemonEvents[E]}` against the distributive `EventAction`
 * union (it isn't preserved through construction), but by signature the pair IS correlated. Confined
 * here so every call site (the controller) stays cast-free.
 */
export const eventAction = <E extends DaemonEventName>(name: E, data: DaemonEvents[E]): Action =>
  ({ type: "event", name, data }) as EventAction;

const RECENT_CAP = 50;
const FAILURE_CAP = 100;
/** Recent progress samples kept for the rate/ETA window. Small on purpose: a short window tracks a
 * changing upload speed, a long one lags it. ~20 ticks is a few seconds of dense small-file progress or a
 * couple of minutes of 64 MiB parts — smoothed either way. */
const SAMPLE_CAP = 20;

/** A fresh run-progress record — used at `runStarted` and as a defensive fallback if a `fileArchived`
 * arrives before one (counts/total become known as events flow / at `runFinished`). */
const startedRun = (): RunProgress => ({
  active: true,
  filesArchived: 0,
  filesTotal: null,
  bytesUploaded: 0,
  bytesTotal: null,
  currentPath: null,
  samples: [],
  blobsFailed: null,
  recent: [],
  uploadProgress: {},
});

/** Smoothed throughput (bytes/sec) over the sample window, or `null` when there isn't enough signal yet
 * (fewer than two samples, no elapsed time, or no forward progress). Pure — takes samples, returns a rate. */
export const throughput = (samples: RunProgress["samples"]): number | null => {
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (!first || !last || first === last) return null;
  const dtSec = (last.t - first.t) / 1000;
  const dBytes = last.bytes - first.bytes;
  if (dtSec <= 0 || dBytes <= 0) return null;
  return dBytes / dtSec;
};

/** Seconds remaining, or `null` when it can't be estimated (unknown total, already done, or no rate yet).
 * Derived from the smoothed `throughput` — deliberately rough, since real upload speed wobbles. */
export const etaSeconds = (
  samples: RunProgress["samples"],
  bytesUploaded: number,
  bytesTotal: number | null,
): number | null => {
  if (!bytesTotal || bytesTotal <= bytesUploaded) return null;
  const rate = throughput(samples);
  if (!rate) return null;
  return (bytesTotal - bytesUploaded) / rate;
};

/** Parse a wire string to a non-negative integer, defaulting to 0 (never NaN). */
const num = (s: string | undefined): number => {
  const n = Number.parseInt(s ?? "", 10);
  return Number.isFinite(n) ? n : 0;
};

export const reducer = (state: AppState, action: Action): AppState => {
  switch (action.type) {
    case "connection":
      return { ...state, connection: action.state };

    case "initialized":
      return { ...state, initializing: false };

    case "authChanged": {
      // Sign-out, or a switch to a DIFFERENT account: drop every vault-derived slice.
      //
      // The daemon is already correct about this — a signed-out `DaemonService` holds no session and so
      // serves nothing (see `UserSession`). But the renderer keeps its own copy of the last user's tree in
      // memory, and `initialState` is only used at construction. Without this, account B would see account
      // A's files rendered for the window between B signing in and the first refetch landing — the same
      // leak, one layer up. Keyed on the ACCOUNT, not merely the state, so an A→B switch resets even
      // though both ends of it are `signedIn`.
      const sameAccount =
        action.auth.state === "signedIn" && action.auth.email === state.auth.email;
      if (sameAccount) return { ...state, auth: action.auth };
      return {
        ...state,
        auth: action.auth,
        status: null,
        files: [],
        excludes: [],
        run: null,
        failures: [],
        restores: {},
        lastError: null,
        lastErrorCode: null,
      };
    }

    case "vaultChanged":
      return { ...state, vault: action.vault };

    case "entitlementChanged":
      return { ...state, entitlement: action.entitlement };

    case "updateChanged":
      return { ...state, update: action.update };

    case "statusLoaded":
      return { ...state, status: action.status };

    case "sourcesLoaded":
      // Patch sources onto the snapshot; if no snapshot yet, hold them until getStatus lands.
      return state.status ? { ...state, status: { ...state.status, sources: action.sources } } : state;

    case "filesLoaded":
      return { ...state, files: action.files };

    case "excludesLoaded":
      return { ...state, excludes: action.excludes };


    case "event":
      return foldEvent(state, action);
  }
};

const foldEvent = (state: AppState, action: EventAction): AppState => {
  switch (action.name) {
    case "runStarted":
      return { ...state, run: startedRun() };

    case "fileArchived": {
      const { file, blob } = action.data;
      const prev = state.run ?? startedRun();
      // It's archived now — drop its live progress entry so no stale bar lingers.
      const { [file]: _done, ...uploadProgress } = prev.uploadProgress;
      return {
        ...state,
        run: {
          ...prev,
          active: true,
          filesArchived: prev.filesArchived + 1,
          recent: [{ file, blob }, ...prev.recent].slice(0, RECENT_CAP),
          uploadProgress,
        },
      };
    }

    case "uploadProgress": {
      const { file, path, bytes, totalBytes } = action.data;
      const prev = state.run ?? startedRun();
      return {
        ...state,
        run: {
          ...prev,
          active: true,
          uploadProgress: { ...prev.uploadProgress, [file]: { path, uploaded: num(bytes), total: num(totalBytes) } },
        },
      };
    }

    case "runProgress": {
      const d = action.data;
      const prev = state.run ?? startedRun();
      const bytesUploaded = num(d.bytesUploaded);
      const bytesTotal = num(d.bytesTotal);
      return {
        ...state,
        run: {
          ...prev,
          active: true,
          filesArchived: num(d.filesArchived),
          filesTotal: num(d.filesTotal),
          bytesUploaded,
          // 0 means "unknown" (a Photos deposit) — keep it null so the UI shows count progress, not a 0-byte bar.
          bytesTotal: bytesTotal > 0 ? bytesTotal : null,
          currentPath: d.currentPath || null,
          samples: [...prev.samples, { t: Date.now(), bytes: bytesUploaded }].slice(-SAMPLE_CAP),
        },
      };
    }

    case "runFinished": {
      const d = action.data;
      const prev = state.run;
      return {
        ...state,
        run: {
          active: false,
          filesArchived: num(d.filesArchived),
          filesTotal: num(d.filesTotal),
          // Snap the bar to 100%: the run is done, so uploaded == total by definition (carry the known total).
          bytesUploaded: prev?.bytesTotal ?? prev?.bytesUploaded ?? 0,
          bytesTotal: prev?.bytesTotal ?? null,
          currentPath: null,
          samples: [],
          blobsFailed: num(d.blobsFailed),
          recent: prev?.recent ?? [],
          uploadProgress: {}, // run's over — no live bars
        },
      };
    }

    case "blobFailed": {
      const { blob, kind, message, paths } = action.data;
      const files = paths ? paths.split("\n").filter(Boolean) : [];
      return { ...state, failures: [{ blob, kind, message, files }, ...state.failures].slice(0, FAILURE_CAP) };
    }

    case "restoreRequested":
      return upsertRestore(state, action.data.file, {
        state: "requested",
        tier: action.data.tier,
      });

    case "restoreInProgress":
      return upsertRestore(state, action.data.file, { state: "inProgress" });

    case "restoreCompleted":
      return upsertRestore(state, action.data.file, { state: "completed", out: action.data.out });

    case "error":
      return { ...state, lastError: action.data.message, lastErrorCode: action.data.code ?? null };

    case "sourcesChanged":
      // Authoritative refresh is the controller's job (it re-issues listSources); no fold here.
      return state;

    case "excludesChanged":
      // Same pattern as sourcesChanged — the controller re-reads listExcludes. No fold here.
      return state;

    case "filesChanged":
      // A reorganize/delete edited the journal tree; the controller re-reads listFiles. No fold here.
      return state;
  }
};

/** Merge a partial update into one file's restore activity (creating it if new). */
const upsertRestore = (
  state: AppState,
  file: string,
  patch: Partial<Omit<RestoreActivity, "file">>,
): AppState => {
  const prev: RestoreActivity = state.restores[file] ?? {
    file,
    state: "requested",
    tier: null,
    out: null,
  };
  return { ...state, restores: { ...state.restores, [file]: { ...prev, ...patch } } };
};
