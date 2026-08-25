/**
 * The event-stream → app-state fold (layer 2). A PURE reducer: `(state, action) → state`, no I/O — so
 * it's unit-testable headless (see reducer.test.ts) and React just binds to the store that wraps it.
 *
 * `status` is the authoritative snapshot (from `getStatus`/`listSources`); `run`, `failures` and
 * `lastError` are folded live from pushed events. `restores` is NOT folded — it is read wholesale from the
 * daemon's journal, which owns it (see {@link AppState.restores}). Daemon event values arrive as STRINGS
 * (the `[String:String]` wire) — numbers are parsed here, the one place that knows the wire shape.
 */
import type {
  AccountStatus,
  AppInfo,
  AuthStatus,
  ConnectionState,
  DaemonEventName,
  DaemonEvents,
  EntitlementStatus,
  ExcludeSuggestion,
  ListedFile,
  RestoreRow,
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
  /** Files a Stop left un-uploaded — known only at `runFinished`; `null` while active. Non-zero means the
   * last run ended because the user stopped it, which the banner reports as such (not as a failure). */
  filesStopped: number | null;
  /** Most-recent-first, capped — for a live "now archiving…" feed. */
  recent: { file: string; blob: string }[];
  /** Live determinate upload progress, keyed by the daemon file id. Each entry carries the file's `path`
   * too, so the browser can match either a journal row (by id) or an optimistic drop row (by path). Only
   * large (solo-blob) files appear here; small batched files flip to archived too fast to bother. Cleared
   * at `runFinished`; an entry is dropped as its file archives.
   *
   * RETAINED, CURRENTLY UNRENDERED: still folded from the daemon's `uploadProgress` event (below), but no
   * view reads it anymore — uploading rows switched from a per-file determinate bar to a plain spinner, and
   * the aggregate progress lives in the deposit banner (`runProgress`). Kept as a latent capability, not
   * dead code. See {@link UploadProgress} in `views/files/model.ts` for the full note. */
  uploadProgress: Record<string, { path: string; uploaded: number; total: number }>;
}

/** Live download progress for one `transferring` restore row, folded from `restoreProgress` events.
 * Ephemeral on purpose — the daemon deliberately doesn't journal a byte counter (a SQLite write every
 * 4 MiB for hours buys nothing; on reconnect the next frame's tick lands within a second), so this slice
 * is the bar's only source. The row's STATE still comes exclusively from `restores`; these entries carry
 * no lifecycle of their own and are pruned the moment their row stops transferring. */
export interface RestoreProgress {
  /** Plaintext bytes decrypted and on disk so far. */
  bytes: number;
  /** The transfer's plaintext size — same figure as its row's `bytes`, so the bar lands on exactly 100%.
   * `null` if the wire ever said 0 (nothing should divide by it). */
  totalBytes: number | null;
  /** Recent `(timestamp, bytes)` ticks, bounded — same signal `throughput`/`etaSeconds` smooth for the
   * deposit banner; one mechanism, both directions (PILLAR3). */
  samples: { t: number; bytes: number }[];
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

// A `RestoreActivity` interface used to live here, folded per-file from `restoreRequested` /
// `restoreInProgress` / `restoreCompleted` events. It was DELETED (2026-07-27) and must not come back as
// a fold.
//
// It was renderer-memory state, which meant a transfer the user had PAID for was lost by `authChanged`
// below (it clears every vault-derived slice) and by any relaunch — the file simply reverted to a green
// "Stored" ✓ with no sign a transfer was ever requested. It also had no state for "bytes are moving", so
// the whole ~48-hour thaw rendered as "Downloading".
//
// Transfers are now durable journal rows the daemon drives and the app READS ({@link AppState.restores},
// filled by `listRestores`). If you want to know where a transfer stands, read the list.

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
  /** Account profile + onboarding facts, pushed from main — what the first-run wizard derives from. */
  account: AccountStatus;
  /** Subscription entitlement (Phase 5c), pushed from main. Gates deposits (not browse/restore). */
  entitlement: EntitlementStatus;
  /** Auto-update status (Phase 6), pushed from main. Packaged app only — stays `idle` in dev. Drives the
   * quiet "Restart to update" affordance when a newer signed build has downloaded. */
  update: UpdateStatus;
  /** This build's version + runtime, read once from main at first paint. Null until it lands (a beat), so
   * the Settings footer can hold a placeholder rather than assert a version it doesn't have yet. */
  appInfo: AppInfo | null;
  status: Status | null;
  /** The browsable tree, straight from the daemon's `listFiles` (journal-backed). Raw wire shape —
   * the file-browser maps it to its own model. Empty until the first read lands. */
  files: ListedFile[];
  /** Whether `files` is a real answer. `[]` alone cannot say: the slice STARTS empty, a signed-out daemon
   * answers `[]` successfully, and a failed read leaves whatever was there. All three rendered as "your
   * vault is empty, drop something" over a 140k-file vault (2026-08-25). So the load carries its own state
   * — `pending` until a read lands, `failed` with the daemon's/socket's own words when it rejects — and
   * the browser shows THAT rather than the empty-vault hero. Reset to `pending` by the account wipe. */
  filesLoad: { state: "pending" } | { state: "loaded" } | { state: "failed"; error: string };
  /** Exclude patterns (daemon `listExcludes`) — Settings' "Don't back up" chips. Authoritative; the
   * daemon seeds defaults on first run + applies them at scan time. */
  excludes: string[];
  /** The opt-in exclude packs the daemon offers (`listExcludeSuggestions`) — Settings' "Suggested skips"
   * shelf and the drop-time prompt both read this. A static catalogue, fetched once per connection;
   * whether a given pack is ON is DERIVED from `excludes` (see `state/excludeSuggestions.ts`), never
   * stored, so there's nothing here that can contradict the chips above it. */
  excludeSuggestions: ExcludeSuggestion[];
  run: RunProgress | null;
  failures: BlobFailure[];
  /** Every transfer this Mac has requested, newest first — active and history — read from the daemon's
   * journal (`listRestores`), never accumulated here. Authoritative: the daemon owns and drives these,
   * so they survive a sign-out, a relaunch, and a closed app. */
  restores: RestoreRow[];
  /** Live download progress keyed by restore row id — see {@link RestoreProgress}. */
  restoreProgress: Record<string, RestoreProgress>;
  lastError: string | null;
  /** The `code` of the most recent daemon `error` (or null) — drives a recovery action on the toast, e.g.
   * `photosAccessDenied` → an "Open Photos settings" button. Cleared (→ null) by any error without a code. */
  lastErrorCode: DaemonEvents["error"]["code"] | null;
}

export const initialState: AppState = {
  initializing: true,
  connection: "connecting",
  auth: { configured: false, state: "signedOut", email: null, name: null, error: null, emailAvailable: false },
  vault: { state: "locked", recoveryCode: null, error: null, step: null, stepSince: null },
  account: { known: false, displayName: null, onboarded: false, recoveryCodeConfirmed: false, error: null },
  entitlement: { known: false, active: false, checkingOut: false, quotaBytes: null, error: null },
  update: { state: "idle", version: null, percent: null, error: null, lastCheckedAt: null },
  appInfo: null,
  status: null,
  files: [],
  filesLoad: { state: "pending" },
  excludes: [],
  excludeSuggestions: [],
  run: null,
  failures: [],
  restores: [],
  restoreProgress: {},
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
  | { type: "accountChanged"; account: AccountStatus }
  | { type: "entitlementChanged"; entitlement: EntitlementStatus }
  | { type: "updateChanged"; update: UpdateStatus }
  | { type: "appInfoLoaded"; appInfo: AppInfo }
  | { type: "statusLoaded"; status: Status }
  | { type: "sourcesLoaded"; sources: Source[] }
  | { type: "filesLoaded"; files: ListedFile[] }
  | { type: "filesLoadFailed"; error: string }
  | { type: "excludesLoaded"; excludes: string[] }
  | { type: "excludeSuggestionsLoaded"; suggestions: ExcludeSuggestion[] }
  | { type: "restoresLoaded"; restores: RestoreRow[] }
  | { type: "failuresDismissed" }
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
/** How far back the rate/ETA window looks, in ms. A TIME window, deliberately, over the tick-count window
 * it replaced (2026-08-24): the daemon ticks `runProgress` on every event — each file starting, each
 * file archived, each 64 MiB part shipped — and only the last kind moves bytes. On a 30 GB folder of tiny
 * files the last 20 ticks were ten files' worth of zero-byte events spanning a random fraction of a second,
 * so the "rate" was `one part (or none) ÷ whatever that slice took`, and the ETA lurched 20 → 25 → 22 days
 * on every file. Two minutes of real transfer covers a few parts even on a slow link, so the average has
 * something to average; short enough that a speed change shows within a couple of minutes. */
const SAMPLE_WINDOW_MS = 120_000;
/** Hard ceiling on samples kept, so a tick stream can't grow the window without bound. Sized so it is
 * NOT the binding constraint: the chattiest stream is a restore (a tick per 4 MiB frame), which at
 * 100 MB/s is ~25 ticks/s ≈ 3,000 over the window. Each sample is two numbers, so 5,000 is nothing. */
const SAMPLE_CAP = 5000;

/** Fold one progress tick into the sample window. Pure. Two rules, both about honesty of the measurement:
 * only a tick that MOVED bytes is a sample (an item-start or file-archived tick says nothing about speed),
 * and samples older than `SAMPLE_WINDOW_MS` are dropped — except the newest of them, kept as the anchor so
 * the rate always spans at least the full window rather than just the ticks that happen to fall inside it. */
export const foldSample = (
  samples: RunProgress["samples"],
  bytes: number,
  now: number,
): RunProgress["samples"] => {
  const last = samples[samples.length - 1];
  if (last && bytes <= last.bytes) return samples;
  const next = [...samples, { t: now, bytes }];
  const cutoff = now - SAMPLE_WINDOW_MS;
  let firstInside = next.findIndex((x) => x.t >= cutoff);
  if (firstInside === -1) firstInside = next.length - 1;
  return next.slice(Math.max(0, firstInside - 1)).slice(-SAMPLE_CAP);
};

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
  filesStopped: null,
  recent: [],
  uploadProgress: {},
});

/** Smoothed throughput (bytes/sec) across the sample window — first sample to last, so it's the average
 * over up to `SAMPLE_WINDOW_MS` of real transfer — or `null` when there isn't enough signal yet (fewer
 * than two samples, no elapsed time, or no forward progress). Pure — takes samples, returns a rate. */
export const throughput = (samples: RunProgress["samples"]): number | null => {
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (!first || !last || first === last) return null;
  const dtSec = (last.t - first.t) / 1000;
  const dBytes = last.bytes - first.bytes;
  if (dtSec <= 0 || dBytes <= 0) return null;
  return dBytes / dtSec;
};

/** How much of a transfer has to be behind us before its measured rate is allowed to speak for the rest
 * of it. Under this, the sample window covers a sliver — one small file out of six, a connection still
 * ramping — and extrapolating it across the whole job produces a number that is not merely imprecise but
 * wrong by orders of magnitude, and alarming with it ("about 8 days 8 hours left" on an upload that took
 * minutes). An honest blank beats a confident lie (PILLAR5). */
const ETA_MIN_FRACTION = 0.01;

/** Seconds remaining, or `null` when it can't be estimated (unknown total, already done, no rate yet, or
 * too little of the job done to extrapolate from). Derived from the smoothed `throughput` — deliberately
 * rough, since real upload speed wobbles. */
export const etaSeconds = (
  samples: RunProgress["samples"],
  bytesUploaded: number,
  bytesTotal: number | null,
): number | null => {
  if (!bytesTotal || bytesTotal <= bytesUploaded) return null;
  if (bytesUploaded < bytesTotal * ETA_MIN_FRACTION) return null;
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
        filesLoad: { state: "pending" },
        excludes: [],
        run: null,
        failures: [],
        restores: [],
        restoreProgress: {},
        lastError: null,
        lastErrorCode: null,
      };
    }

    case "vaultChanged":
      return { ...state, vault: action.vault };

    case "accountChanged":
      return { ...state, account: action.account };

    case "entitlementChanged":
      return { ...state, entitlement: action.entitlement };

    case "updateChanged":
      return { ...state, update: action.update };

    case "appInfoLoaded":
      return { ...state, appInfo: action.appInfo };

    case "statusLoaded":
      return { ...state, status: action.status };

    case "sourcesLoaded":
      // Patch sources onto the snapshot; if no snapshot yet, hold them until getStatus lands.
      return state.status ? { ...state, status: { ...state.status, sources: action.sources } } : state;

    case "filesLoaded":
      return { ...state, files: action.files, filesLoad: { state: "loaded" } };
    case "filesLoadFailed":
      // Keep the last good tree (stale beats blank); only the load state says it couldn't be refreshed.
      return { ...state, filesLoad: { state: "failed", error: action.error } };

    case "excludesLoaded":
      return { ...state, excludes: action.excludes };
    case "excludeSuggestionsLoaded":
      return { ...state, excludeSuggestions: action.suggestions };

    case "restoresLoaded": {
      // The authoritative list is also the progress slice's janitor: an entry whose row is no longer
      // `transferring` (saved, stopped, failed, forgotten, superseded) is done narrating — pruning here,
      // on the one action that knows every row's true state, is what keeps the slice from leaking a stale
      // bar per completed transfer for the life of the session.
      const transferring = new Set(
        action.restores.filter((r) => r.state === "transferring").map((r) => r.id),
      );
      const restoreProgress = Object.fromEntries(
        Object.entries(state.restoreProgress).filter(([id]) => transferring.has(id)),
      );
      return { ...state, restores: action.restores, restoreProgress };
    }

    case "failuresDismissed":
      // The user acknowledged the "couldn't upload" pill and asked it gone. An acknowledgement, not a
      // resolution: the affected file rows keep their journal-backed ⚠ status, and a daemon that re-hits
      // the same fault (e.g. a still-over-quota blob on the next auto-run pass) re-adds its failure —
      // the pill re-asserting a still-true condition is honest, not a dismissal bug.
      return { ...state, failures: [] };


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
      // The blob went through, so any recorded failure for it is stale — prune it. Blob ids are
      // content-derived and stable across runs (BlobPlanner.stableId), so a retried blob that finally
      // lands carries the SAME id its failure was recorded under; without this, the "couldn't upload"
      // pill keeps counting an upload that has since succeeded.
      const failures = state.failures.some((f) => f.blob === blob)
        ? state.failures.filter((f) => f.blob !== blob)
        : state.failures;
      return {
        ...state,
        failures,
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
          // The rate window starts at the FIRST BYTE, not at the run. Progress ticks arrive during the
          // encrypt/prepare stall too, and anchoring the window on a `bytes: 0` sample turns the "rate"
          // into an average that includes all that dead time — which is how a 2 GB deposit read
          // "2 KB of 2 GB · 3 KB/s · about 8 days 8 hours left" seconds after the drop (2026-08-24).
          // Until something moves there is nothing true to say about a rate, so we say nothing. Past the
          // first byte, `foldSample` keeps only the ticks that moved bytes — see it for why.
          samples: bytesUploaded === 0 ? [] : foldSample(prev.samples, bytesUploaded, Date.now()),
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
          filesStopped: num(d.filesStopped),
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

    case "restoresChanged":
    case "restoreCompleted":
      // Authoritative refresh is the controller's job (it re-reads `listRestores`); no fold here. Same
      // pattern as sourcesChanged/filesChanged — and for a stronger reason: a renderer-side fold of these
      // is what used to lose an in-flight transfer on sign-out.
      return state;

    case "restoreProgress": {
      // The one restore event that IS folded — deliberately, and the "no fold" rule above survives it:
      // this carries no lifecycle (no states, no rows), only a byte counter for a bar. Losing it on
      // sign-out is correct (the transfer keeps going; the counter re-fills on the next frame's tick).
      const { id, bytes, totalBytes } = action.data;
      const prev = state.restoreProgress[id];
      const done = num(bytes);
      const total = num(totalBytes);
      return {
        ...state,
        restoreProgress: {
          ...state.restoreProgress,
          [id]: {
            bytes: done,
            totalBytes: total > 0 ? total : null,
            // Same first-byte rule as a deposit's window, and for the same reason — see `runProgress`.
            samples: done === 0 ? [] : foldSample(prev?.samples ?? [], done, Date.now()),
          },
        },
      };
    }

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
