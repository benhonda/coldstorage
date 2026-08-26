/**
 * The Uploads page's model — **one row per thing the user did** (a drop, a photo pick), plus one per
 * watched folder, with the tree's own rows folded in for the counts.
 *
 * The daemon's journal is per-file underneath and stays that way; `listDeposits` hands over the batches
 * (identity, what was dropped, when, whether it's still owed) and every count here is derived at render
 * time from the SAME `ArchivedFile` rows My Files draws, keyed by `depositId`. That is what lets a batch
 * say "3 of 500 couldn't upload" and the tree mark exactly 3 rows ⚠ without the two ever disagreeing —
 * there is no stored count to drift.
 */
import type { Deposit, FileFailureKind, Source } from "../../../../shared/ipc.ts";
import type { ArchivedFile } from "../files/model.ts";
import { baseName } from "../files/model.ts";
import { FAILURE_ORDER } from "./failure.ts";

export interface Counts {
  /** Verified in storage. */
  stored: number;
  /** Queued, uploading, or retrying against a snag. */
  inFlight: number;
  failed: number;
  /** Failed rows the daemon can retry by itself — a recorded source, so "Try again" has something to read. */
  retryable: number;
}

/** The failed rows of one batch, one bucket per cause, worst-for-the-user first. */
export interface FailureGroup {
  kind: FileFailureKind;
  files: ArchivedFile[];
}

/**
 * The headline state of a batch — the one thing most worth saying about it.
 *  - `uploading`: the daemon still owes it and is running right now.
 *  - `waiting`: still owed, nothing running — it picks up on the next pass (a stop, a snag, a drive that
 *    isn't plugged in).
 *  - `didntFinish`: settled, and some of it never landed. The state this page exists for.
 *  - `done`: settled, everything stored.
 */
export type BatchState = "uploading" | "waiting" | "didntFinish" | "done";

export interface UploadBatch {
  type: "batch";
  id: string;
  /** What it's called — the dropped item's name, "a, b and 2 more", or "N photos". */
  name: string;
  kind: Deposit["kind"];
  /** Where it landed in My Files ("" = the top level). */
  dest: string;
  state: BatchState;
  createdAt: number;
  finishedAt: number | null;
  counts: Counts;
  failures: FailureGroup[];
}

export type FolderState = "paused" | "unreachable" | "didntFinish" | "uploading" | "watching";

/** A watched folder as an upload row: what it has stored, what it hasn't. */
export interface WatchedFolder {
  type: "folder";
  source: Source;
  /** The mount — where it lands in My Files — never the raw path. */
  name: string;
  state: FolderState;
  counts: Counts;
  failures: FailureGroup[];
}

const COUNT_STATUSES: Partial<Record<ArchivedFile["status"], keyof Counts>> = {
  frozen: "stored",
  here: "stored", // a copy saved back on this Mac is still stored
  pending: "stored",
  transferring: "stored",
  uploading: "inFlight",
  stalled: "inFlight",
  failed: "failed",
};

const count = (files: readonly ArchivedFile[]): Counts => {
  const c: Counts = { stored: 0, inFlight: 0, failed: 0, retryable: 0 };
  for (const f of files) {
    const key = COUNT_STATUSES[f.status];
    if (key) c[key] += 1;
    if (f.status === "failed" && f.sourcePath !== null) c.retryable += 1;
  }
  return c;
};

/** Fold failed rows into causes, in {@link FAILURE_ORDER}; a failed row from before kinds existed counts
 * as `permanent` — it has no kinder story, and it must not vanish. */
export const groupFailures = (files: readonly ArchivedFile[]): FailureGroup[] => {
  const byKind = new Map<FileFailureKind, ArchivedFile[]>();
  for (const f of files) {
    if (f.status !== "failed") continue;
    const kind = f.failureKind ?? "permanent";
    const list = byKind.get(kind);
    if (list) list.push(f);
    else byKind.set(kind, [f]);
  }
  return FAILURE_ORDER.flatMap((kind) => {
    const files = byKind.get(kind);
    return files ? [{ kind, files }] : [];
  });
};

/** "drop", "a, b and 2 more", "12 photos" — from what was dropped, never a raw path. */
export const batchName = (d: Pick<Deposit, "kind" | "src">): string => {
  if (d.kind === "photos") return `${d.src.length} ${d.src.length === 1 ? "photo" : "photos"}`;
  const names = d.src.map((s) => baseName(s) || s).filter((n) => n !== "");
  if (names.length === 0) return "Upload";
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} more`;
};

const batchState = (d: Deposit, counts: Counts, runActive: boolean): BatchState => {
  if (d.state === "pending") return runActive && counts.inFlight > 0 ? "uploading" : "waiting";
  return counts.failed > 0 ? "didntFinish" : "done";
};

const folderState = (s: Source, counts: Counts, runActive: boolean): FolderState => {
  if (s.paused) return "paused";
  if (s.error) return "unreachable";
  if (counts.failed > 0) return "didntFinish";
  if (runActive && counts.inFlight > 0) return "uploading";
  return "watching";
};

/** Is `path` the mount itself, or nested under it — the same prefix test as the daemon's
 * `Journal.failedFiles(underMount:)`, so "Try again" on a folder row retries exactly the rows it shows. */
const underMount = (path: string, mount: string): boolean => path === mount || path.startsWith(`${mount}/`);

/** The watched folder an unclaimed file belongs to: the LONGEST mount covering it, so a folder watched
 * inside another watched folder owns its own files and the outer one doesn't count them twice. */
const ownerOf = (path: string, folders: readonly Source[]): Source | undefined =>
  folders.find((s) => underMount(path, s.mountPath));

export interface UploadsModel {
  batches: UploadBatch[];
  folders: WatchedFolder[];
  /** Every failed row in the tree — the nav badge's number, and the same count the ⚠ rows add up to. A
   * row no batch or folder owns (a drop's leftovers after its watched folder was removed, say) is in
   * this number for at most one pass: the daemon adopts every such row into a batch on its next sweep
   * (`Journal.adoptOrphanedFailures`), so the page catches up with the badge by itself. */
  failedTotal: number;
}

/**
 * Build the page. Deposits arrive newest first from the daemon and stay that way. A file belongs to its
 * `depositId` batch if it has one; otherwise to the innermost watched folder whose mount covers it. A file
 * with neither (an optimistic drop row the daemon hasn't claimed yet) belongs to the tree alone. A source
 * with an empty mount is skipped: the daemon never mints one (`addSource` defaults to the basename) and
 * never scans one, so a legacy row like that watches nothing.
 */
export const buildUploads = (
  deposits: readonly Deposit[],
  files: readonly ArchivedFile[],
  sources: readonly Source[],
  runActive: boolean,
): UploadsModel => {
  const watched = sources
    .filter((s) => s.kind === "folder" && s.mountPath !== "")
    .sort((a, b) => b.mountPath.length - a.mountPath.length);
  const byDeposit = new Map<string, ArchivedFile[]>();
  const byFolder = new Map<string, ArchivedFile[]>();
  for (const f of files) {
    const key = f.depositId ?? ownerOf(f.relativePath, watched)?.id;
    if (key === undefined) continue;
    const map = f.depositId === null ? byFolder : byDeposit;
    const list = map.get(key);
    if (list) list.push(f);
    else map.set(key, [f]);
  }
  const batches: UploadBatch[] = deposits.map((d) => {
    const rows = byDeposit.get(d.id) ?? [];
    const counts = count(rows);
    return {
      type: "batch",
      id: d.id,
      name: batchName(d),
      kind: d.kind,
      dest: d.dest,
      state: batchState(d, counts, runActive),
      createdAt: d.createdAt,
      finishedAt: d.finishedAt,
      counts,
      failures: groupFailures(rows),
    };
  });
  const folders: WatchedFolder[] = sources
    .filter((s) => s.kind === "folder" && s.mountPath !== "")
    .map((s) => {
      const rows = byFolder.get(s.id) ?? [];
      const counts = count(rows);
      return {
        type: "folder",
        source: s,
        name: s.mountPath,
        state: folderState(s, counts, runActive),
        counts,
        failures: groupFailures(rows),
      };
    });
  return { batches, folders, failedTotal: files.reduce((n, f) => n + (f.status === "failed" ? 1 : 0), 0) };
};
