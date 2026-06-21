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
}

export interface BlobFailure {
  blob: string;
  kind: "permanent" | "transient";
  message: string;
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
  run: RunProgress | null;
  failures: BlobFailure[];
  /** Keyed by file id. */
  restores: Record<string, RestoreActivity>;
  lastError: string | null;
}

export const initialState: AppState = {
  connection: "connecting",
  status: null,
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
      return {
        ...state,
        run: {
          ...prev,
          active: true,
          filesArchived: prev.filesArchived + 1,
          recent: [{ file, blob }, ...prev.recent].slice(0, RECENT_CAP),
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
        },
      };
    }

    case "blobFailed": {
      const { blob, kind, message } = action.data;
      return { ...state, failures: [{ blob, kind, message }, ...state.failures].slice(0, FAILURE_CAP) };
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
