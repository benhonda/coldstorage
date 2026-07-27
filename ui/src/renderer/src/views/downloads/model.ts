/**
 * The Downloads page's grouping model — **one row per request, not per file**.
 *
 * The daemon's journal is per-file by design: each file is the durable unit of work, with its own state
 * machine, destination and error slot, and `listRestores` faithfully returns that list. But nobody asks
 * for 300 files — they ask for a folder, once, priced by one quote. `jobId` IS that quote (the backend
 * retrieval job every row of the request was authorized under), so it is the truthful group key:
 * everything bought together shows together. Grouping happens here, at render time — the wire and the
 * journal stay per-file, which is exactly what keeps stop/resume/partial failure working file-by-file
 * underneath the grouped row.
 */
import type { RestoreRow, RestoreState } from "../../../../shared/ipc.ts";
import type { RestoreProgress } from "../../state/reducer.ts";
import { baseName, commonParent } from "../files/model.ts";

/** One request — what renders as a single row on the Downloads page. */
export interface DownloadGroup {
  /** The group key: the request's `jobId`, or the lone row's own id when it has none (dogfood mode,
   * where no backend job exists). Rows without a jobId are never merged with each other — two unrelated
   * dogfood requests sharing a "null" group would be a lie. */
  key: string;
  /** Every file riding in this request, in the daemon's list order. */
  rows: RestoreRow[];
  /** What the row is called: the requested folder for a multi-file ask ("Photos"), the file itself for
   * a single — derived from the rows' shared vault directory, since the journal doesn't store the
   * original ask. Null when a multi-select genuinely shares no folder: there is no honest single name
   * for that, and the view falls back to the file count instead of this model inventing one. */
  label: string | null;
  /** The headline state — see {@link aggregateState}. */
  state: RestoreState;
  /** Plaintext bytes across the whole request. */
  bytes: number;
  /** When it was asked for. One request is issued in one burst, so the earliest row speaks for all. */
  requestedAt: number;
  /** When the last file landed — only once every file has (a half-saved request has no finish time). */
  completedAt: number | null;
  doneCount: number;
  failedCount: number;
}

/**
 * The headline state for a grouped row — the one thing most worth saying about a request whose files
 * disagree. Precedence, and why: an unpaid part outranks everything (there's a button to press and
 * nothing moves until it is); live movement outranks waiting (it's the newer fact); and once nothing is
 * active anymore, bad news outranks tidy endings — a request with a failed file must not read "Done".
 */
const PRECEDENCE: readonly RestoreState[] = [
  "needsAuthorization",
  "transferring",
  "pending",
  "failed",
  "canceled",
  "saved",
];

export const aggregateState = (rows: readonly RestoreRow[]): RestoreState => {
  const present = new Set(rows.map((r) => r.state));
  return PRECEDENCE.find((s) => present.has(s)) ?? "saved";
};

/** "Photos" for a folder ask, the file's own name for a single, null for a mixed multi-select. */
const labelFor = (rows: readonly RestoreRow[]): string | null => {
  if (rows.length === 1) return baseName(rows[0]!.relativePath);
  const dir = commonParent(rows.map((r) => r.relativePath));
  return dir === "" ? null : (dir.split("/").at(-1) ?? dir);
};

/**
 * Fold the per-file list into request rows, ordered by each request's first appearance (the daemon
 * lists newest first, so the newest request leads).
 */
export const groupDownloads = (rows: readonly RestoreRow[]): DownloadGroup[] => {
  const byKey = new Map<string, RestoreRow[]>();
  for (const r of rows) {
    const key = r.jobId ?? `solo:${r.id}`;
    const bucket = byKey.get(key);
    if (bucket) bucket.push(r);
    else byKey.set(key, [r]);
  }
  return [...byKey.entries()].map(([key, members]) => {
    const done = members.filter((r) => r.state === "saved");
    const allDone = done.length === members.length;
    return {
      key,
      rows: members,
      label: labelFor(members),
      state: aggregateState(members),
      bytes: members.reduce((n, r) => n + r.bytes, 0),
      requestedAt: Math.min(...members.map((r) => r.requestedAt)),
      completedAt: allDone ? Math.max(...done.map((r) => r.completedAt ?? 0)) || null : null,
      doneCount: done.length,
      failedCount: members.filter((r) => r.state === "failed").length,
    };
  });
};

/**
 * The row whose countdown speaks for a waiting group: the pending file with the LATEST estimated
 * ready-by. The request is done thawing when its slowest file is, so any earlier clock would promise
 * a finish the group can't keep.
 */
export const latestPendingRow = (rows: readonly RestoreRow[]): RestoreRow | undefined =>
  rows
    .filter((r) => r.state === "pending")
    .reduce<RestoreRow | undefined>(
      (best, r) =>
        !best || r.requestedAt + r.typicalWaitSeconds > best.requestedAt + best.typicalWaitSeconds ? r : best,
      undefined,
    );

/**
 * The measured fraction for a downloading group's bar: bytes already saved plus bytes mid-flight, over
 * the request's total. Every term is plaintext bytes (`RestoreRow.bytes`, and the daemon's plaintext
 * `restoreProgress` ticks), so the fraction is honest. Null when nothing has landed yet or the total is
 * unknown — the bar shimmers indeterminate rather than inventing a number (same contract as
 * `progressFraction` on a single row).
 */
export const groupFraction = (
  g: DownloadGroup,
  progress: Record<string, RestoreProgress>,
): number | null => {
  if (g.bytes <= 0) return null;
  const savedBytes = g.rows.reduce((n, r) => (r.state === "saved" ? n + r.bytes : n), 0);
  const liveBytes = g.rows.reduce((n, r) => n + (progress[r.id]?.bytes ?? 0), 0);
  const landed = savedBytes + liveBytes;
  return landed > 0 ? Math.min(1, landed / g.bytes) : null;
};

/** The folder a download saves into (the destination minus the filename). Guards the no-slash case: with
 * no separator `lastIndexOf` is -1, and `slice(0, -1)` would quietly lop off the last character instead. */
export const folderOf = (out: string): string => {
  const cut = out.lastIndexOf("/");
  return cut > 0 ? out.slice(0, cut) : "/";
};

/**
 * Where a finished request landed, for its one "Show in Finder": the deepest folder shared by every
 * file's destination. A folder request saves under `<chosen>/<folder>/…`, so this is that folder; a
 * flat multi-select resolves to the chosen destination itself. Falls back to the first file's own
 * folder when nothing is shared (destinations at the filesystem root — shouldn't happen, but a reveal
 * that opens *somewhere real* beats one built from an empty string).
 */
export const commonOutDir = (rows: readonly RestoreRow[]): string => {
  const dir = commonParent(rows.map((r) => r.out));
  return dir === "" ? folderOf(rows[0]?.out ?? "/") : dir;
};
