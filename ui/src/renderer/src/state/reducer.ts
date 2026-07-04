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
  Pricing,
  Source,
  Status,
  UpdateStatus,
  VaultStatus,
} from "../../../shared/ipc.ts";
import { FALLBACK_PRICING } from "../views/files/pricing.ts";

/** Live progress of the current/most-recent run, folded from runStarted/fileArchived/runFinished. */
export interface RunProgress {
  active: boolean;
  /** Files archived so far (live count while active; final total when finished). */
  filesArchived: number;
  /** Total in scope — unknown until `runFinished` reports it. */
  filesTotal: number | null;
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
  kind: "permanent" | "transient";
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
  /** Storage/retrieval rate card (daemon `getPricing`) — what cost/fee figures quote from. Seeded with
   * a fallback so first paint isn't blank, replaced by the real quote on connect (never null). */
  pricing: Pricing;
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
  entitlement: { known: false, active: false, checkingOut: false, error: null },
  update: { state: "idle", version: null, percent: null, error: null },
  status: null,
  files: [],
  excludes: [],
  pricing: FALLBACK_PRICING,
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
  | { type: "pricingLoaded"; pricing: Pricing }
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

/** A fresh run-progress record — used at `runStarted` and as a defensive fallback if a `fileArchived`
 * arrives before one (counts/total become known as events flow / at `runFinished`). */
const startedRun = (): RunProgress => ({
  active: true,
  filesArchived: 0,
  filesTotal: null,
  blobsFailed: null,
  recent: [],
  uploadProgress: {},
});

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

    case "authChanged":
      return { ...state, auth: action.auth };

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

    case "pricingLoaded":
      return { ...state, pricing: action.pricing };

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

    case "runFinished": {
      const d = action.data;
      return {
        ...state,
        run: {
          active: false,
          filesArchived: num(d.filesArchived),
          filesTotal: num(d.filesTotal),
          blobsFailed: num(d.blobsFailed),
          recent: state.run?.recent ?? [],
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
