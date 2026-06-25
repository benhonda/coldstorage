/**
 * The event-stream → app-state fold (layer 2). A PURE reducer: `(state, action) → state`, no I/O — so
 * it's unit-testable headless (see reducer.test.ts) and React just binds to the store that wraps it.
 *
 * `status` is the authoritative snapshot (from `getStatus`/`listSources`); `run`, `failures`,
 * `restores`, `lastError` are folded live from pushed events. Daemon event values arrive as STRINGS
 * (the `[String:String]` wire) — numbers are parsed here, the one place that knows the wire shape.
 */
import type {
  ConnectionState,
  DaemonEventName,
  DaemonEvents,
  ListedFile,
  Source,
  Status,
} from "../../../shared/ipc.ts";

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
  connection: ConnectionState;
  status: Status | null;
  /** The browsable tree, straight from the daemon's `listFiles` (journal-backed). Raw wire shape —
   * the file-browser maps it to its own model. Empty until the first read lands. */
  files: ListedFile[];
  run: RunProgress | null;
  failures: BlobFailure[];
  /** Keyed by file id. */
  restores: Record<string, RestoreActivity>;
  lastError: string | null;
}

export const initialState: AppState = {
  connection: "connecting",
  status: null,
  files: [],
  run: null,
  failures: [],
  restores: {},
  lastError: null,
};

/** Distributive event action — keeps each event name correlated with its own data shape (for the
 * reducer's `switch`, which narrows `data` per `name`). */
type EventAction = {
  [E in DaemonEventName]: { type: "event"; name: E; data: DaemonEvents[E] };
}[DaemonEventName];

export type Action =
  | { type: "connection"; state: ConnectionState }
  | { type: "statusLoaded"; status: Status }
  | { type: "sourcesLoaded"; sources: Source[] }
  | { type: "filesLoaded"; files: ListedFile[] }
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

    case "statusLoaded":
      return { ...state, status: action.status };

    case "sourcesLoaded":
      // Patch sources onto the snapshot; if no snapshot yet, hold them until getStatus lands.
      return state.status ? { ...state, status: { ...state.status, sources: action.sources } } : state;

    case "filesLoaded":
      return { ...state, files: action.files };

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

    case "paused":
      return state.status ? { ...state, status: { ...state.status, paused: true } } : state;

    case "resumed":
      return state.status ? { ...state, status: { ...state.status, paused: false } } : state;

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
      return { ...state, lastError: action.data.message };

    case "sourcesChanged":
      // Authoritative refresh is the controller's job (it re-issues listSources); no fold here.
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
