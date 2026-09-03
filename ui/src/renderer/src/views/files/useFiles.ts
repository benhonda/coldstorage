/**
 * The file-browser state + reorganize ops — the renderer's view of the vault tree.
 *
 * The daemon's `listFiles` (journal-backed) is the truth, passed in as `daemonFiles` + `persistedFolders`
 * with the tree `revision` they were read at. deposit/move/rename/delete/newFolder each add an OPTIMISTIC
 * op (instant feedback) that is re-applied on top of every read until the daemon provably reflects it —
 * the read at or past the revision its ack named — and then let go. The op's handle is how the view ties
 * the two together: fire the REAL daemon command, `settle(ack.revision)` on success, `rollback()` on
 * rejection. The semantics live in `overlay.ts`; this hook owns the state and the handles.
 *
 * Transfer status IS real: request-back calls the daemon's `requestRestore`, which writes a durable
 * journal row; the daemon's run loop drives it and the app READS the list (`listRestores`). We overlay
 * the newest transfer per file here, so a file the user asked back shows `pending` (deep storage is
 * waking up) / `transferring` (bytes moving) / `here` (saved) in the tree. Pass the store's `restores` in.
 * A download that ISN'T moving — unpaid, or stalled — deliberately overlays nothing; see `applyRestore`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RestoreRow } from "../../../../shared/ipc.ts";
import { restoreStall } from "../../../../shared/ipc.ts";
import {
  type ArchivedFile,
  type FileStatus,
  type RowTarget,
  baseName,
  joinPath,
  kindFromName,
  parentOf,
  uploadStall,
} from "./model.ts";
import { type PendingOp, type TreeOp, acceptDeposit, applyOps, prune, rollback, settle } from "./overlay.ts";

let depositSeq = 0;
let opSeq = 0;
/** An optimistic row's id — one the daemon has never seen. A retry on such a row can't go through
 * `retryFiles` (no journal row to requeue); it re-issues the original `deposit` from the dropped path. */
const OPTIMISTIC_PREFIX = "dep-";
const optimisticId = (stamp: number, i: number): string => `${OPTIMISTIC_PREFIX}${stamp}-${i}`;
export const isOptimisticId = (id: string): boolean => id.startsWith(OPTIMISTIC_PREFIX);

/** The handle every optimistic edit hands back — the view's side of the bargain with the daemon. */
export interface OpHandle {
  /** The daemon did it: hold the edit until the read at or past `revision` (the ack's). No revision means
   * the edit touched only optimistic rows (nothing daemon-side to wait for) — it folds into them and goes. */
  settle: (revision?: number) => void;
  /** The daemon refused: drop the edit, the tree snaps back to what the daemon has. */
  rollback: () => void;
}

/**
 * Tie an optimistic edit to the command that makes it real: settle it at the ack's revision (the highest,
 * when one edit is several commands), or roll it back if the daemon refused. Returns the ack(s) so the
 * caller can read anything else off them (`isWatched`, retry counts). Rejection propagates — the view's
 * `exec` owns the toast.
 */
export const settleWith = async <R extends { revision: number } | { revision: number }[]>(
  handle: OpHandle,
  command: Promise<R>,
): Promise<R> => {
  let acked: R;
  try {
    acked = await command;
  } catch (e) {
    handle.rollback();
    throw e;
  }
  handle.settle(Math.max(...(Array.isArray(acked) ? acked : [acked]).map((a) => a.revision)));
  return acked;
};

export interface FilesApi {
  /** The flat file list with live restore status overlaid — the browser renders the tree from this. */
  files: ArchivedFile[];
  /** Just-created, still-empty folders (virtual paths) to surface alongside the derived tree. */
  virtualFolders: string[];
  /** Add optimistic "uploading" rows for dropped items in `intoDir` (each carrying its local `sourcePath` for
   * retry, and its byte `size` where known — file drops know it up front, photo picks don't until the
   * daemon resolves them); returns their ids. The rows hold until the read past their deposit's run ends,
   * which is why the caller MUST {@link depositAccepted} them with the ack's batch id — or flip them failed
   * via {@link setDepositStatus} when the command is refused. The `size` feeds the deposit gate's in-flight
   * accounting, so an uploading row counts against the quota before its bytes ever land (see
   * `state/entitlement.ts`). */
  deposit: (items: { name: string; sourcePath?: string; size?: number }[], intoDir: string) => string[];
  /** The daemon accepted a deposit for these optimistic rows under `depositId`: they now settle on THAT
   * run's `runFinished`. */
  depositAccepted: (ids: string[], depositId: string) => void;
  /** Flip rows' status (uploading ⇄ failed) by id — drives the retry cycle and keeps a failed upload visible
   * ON the file (⚠ couldn't upload) rather than vanishing or stuck on "uploading". Works on journal rows
   * (a retry's optimistic flip, settled by `retryFiles`' revision) and optimistic ones alike.
   *
   * `reason` rides along so the ⚠ can say WHY, the same as a journal-backed failure now does. Without it the
   * most immediate failure — the deposit you just asked for, rejected a second ago — would be the one with
   * no explanation, while a background fault from an hour ago had one. Passing `null` (a retry going back to
   * "uploading") clears it, for the reason every sibling clears on success. */
  setDepositStatus: (ids: string[], status: FileStatus, reason?: string | null) => OpHandle;
  /** Rename a file or folder (journal basename edit / prefix sweep). */
  rename: (target: RowTarget, newName: string) => OpHandle;
  /** Move files/folders under `toDir` (journal re-parent / prefix sweep — no S3, no thaw). */
  move: (targets: RowTarget[], toDir: string) => OpHandle;
  /** Tombstone files/folders (drops from the tree; bytes aren't reclaimed — see delete copy). */
  remove: (targets: RowTarget[]) => OpHandle;
  /** Create an empty folder under `intoDir`; returns its path (so the caller can inline-rename it) + handle. */
  newFolder: (intoDir: string) => { path: string; handle: OpHandle };
}

/** The per-file status a download implies. Only the states that CHANGE how the file reads are mapped: a
 * canceled or failed download leaves the file exactly as it was (still safely stored — the copy didn't
 * arrive, the archive is untouched), so those keep the journal's own status and surface on the Transfers
 * page instead of putting a scary mark on a file that is perfectly fine. */
const STATUS_FROM_TRANSFER: Partial<Record<RestoreRow["state"], FileStatus>> = {
  pending: "pending",
  transferring: "transferring",
  saved: "here",
};

/**
 * Overlay a file's newest transfer onto its row — but only while that transfer is actually MOVING.
 *
 * `pending` on a tree row means one thing: deep storage is waking this up, hands off, it'll arrive. Two
 * kinds of download can't say that and used to anyway. An unpaid one (`needsAuthorization`) is waiting on
 * the user's card, not on AWS — it was mapped here on the reasoning that "a copy is on the way", which is
 * the one thing it isn't. And a stalled one (`restoreStall` — nothing has checked on it in longer than the
 * daemon's own window, or it has run far past its estimate) is a wait nobody can vouch for.
 *
 * Both now leave the file reading exactly what it is: safely stored. That is the truth about the FILE —
 * the archive is untouched, nothing is at risk — and the thing that needs doing about the download is on
 * the Downloads page, which states it plainly and offers the button. The alternative, a scary mark on a
 * file that is perfectly fine, would trade one wrong impression for another.
 */
const applyRestore = (
  file: ArchivedFile,
  r: RestoreRow | undefined,
  now: number,
  staleAfter: number,
): ArchivedFile => {
  const status = r && STATUS_FROM_TRANSFER[r.state];
  if (!r || !status || restoreStall(r, now, staleAfter) !== null) return file;
  return { ...file, status, localPath: r.state === "saved" ? r.out : (file.localPath ?? null) };
};

/**
 * Flip a file that says "Uploading" to `stalled` when it has stopped getting anywhere ({@link uploadStall}).
 *
 * The upload twin of the guard in {@link applyRestore}, and the older of the two problems: `planned` in the
 * journal renders as "Uploading", and until the daemon started recording transient faults and stamping
 * `lastAttemptAt`, that arrow had no expiry and no reason attached. A file whose blob had been failing all
 * week looked exactly like one queued a second ago.
 */
const applyUpload = (file: ArchivedFile, now: number, staleAfter: number): ArchivedFile =>
  uploadStall(file, now, staleAfter) !== null ? { ...file, status: "stalled" } : file;

export const useFiles = (
  daemonFiles: ArchivedFile[],
  persistedFolders: string[],
  restores: readonly RestoreRow[],
  /** The daemon's own silence window (`Status.staleAfterSeconds`); `Infinity` with no snapshot. */
  staleAfter: number,
  /** The tree revision `daemonFiles` was read at (`AppState.filesRevision`) — the clock the ops settle by. */
  revision: number,
  /** Batch id → the revision its run finished at (`AppState.depositRuns`) — when a drop's rows may go. */
  depositRuns: Readonly<Record<string, number>>,
): FilesApi => {
  const [ops, setOps] = useState<PendingOp[]>([]);

  // The revision counts per daemon process, and the reducer zeroes it on every (re)connect. A revision
  // that went BACKWARDS is that reset: whatever we were holding was for a daemon that's gone, and no ack
  // from the new one will ever settle it. Let it all go — the new daemon's tree is the truth now.
  const lastRevision = useRef(revision);
  useEffect(() => {
    if (revision < lastRevision.current) setOps([]);
    lastRevision.current = revision;
  }, [revision]);

  // Keep only the ops the daemon hasn't provably reflected yet. Done in state (not just in the memo below)
  // so settled ops don't pile up for the session.
  useEffect(() => {
    setOps((prev) => {
      const next = prune(prev, revision, depositRuns);
      return next.length === prev.length ? prev : next;
    });
  }, [revision, depositRuns]);

  const overlaid = useMemo(
    () => applyOps({ files: daemonFiles, folders: persistedFolders }, prune(ops, revision, depositRuns)),
    [daemonFiles, persistedFolders, ops, revision, depositRuns],
  );

  // Index the transfer list by file, keeping only the NEWEST per file: the list is history as well as
  // active work, so a file fetched back twice has several rows and only the latest describes it now.
  // (`listRestores` is newest-first, so the first one wins.)
  const newestByFile = useMemo(() => {
    const m = new Map<string, RestoreRow>();
    for (const r of restores) if (!m.has(r.fileId)) m.set(r.fileId, r);
    return m;
  }, [restores]);

  // Overlay transfer status by file id — keeps the tree truthful as a real thaw progresses.
  //
  // `Date.now()` inside the memo rather than a ticking clock: staleness turns over on a scale of a day, and
  // this recomputes on every `restores` change — which is now once per daemon pass while anything is in
  // flight, plus every mount. The moment that matters most is app-open after a long absence, and that is a
  // mount. A 15s interval here would buy nothing but renders.
  const files = useMemo(() => {
    const now = Math.floor(Date.now() / 1000);
    return overlaid.files.map((file) =>
      applyUpload(applyRestore(file, newestByFile.get(file.id), now, staleAfter), now, staleAfter),
    );
  }, [overlaid.files, newestByFile, staleAfter]);

  /** Add an op; hand back its handle. */
  const add = useCallback((op: TreeOp): { id: number; handle: OpHandle } => {
    const id = ++opSeq;
    setOps((prev) => [...prev, { id, op, until: null }]);
    return {
      id,
      handle: {
        settle: (rev = 0) => setOps((prev) => settle(prev, id, rev)),
        rollback: () => setOps((prev) => rollback(prev, id)),
      },
    };
  }, []);

  const deposit = useCallback(
    (items: { name: string; sourcePath?: string; size?: number }[], intoDir: string): string[] => {
      const stamp = ++depositSeq;
      const rows: ArchivedFile[] = items.map((it, i) => ({
        id: optimisticId(stamp, i),
        relativePath: joinPath(intoDir, it.name),
        // Real size where the caller knows it (a file drop) so this row counts against the quota while it
        // uploads; 0 when unknown (a photo pick, resolved daemon-side) — the daemon's usage read catches
        // those up on the next refresh. The authoritative size replaces this on the post-runFinished reread.
        size: it.size ?? 0,
        status: "uploading",
        kind: kindFromName(it.name),
        date: null,
        modifiedAt: null,
        createdAt: null,
        // Nothing has tried this yet — it was dropped a moment ago and the deposit command is still in
        // flight. `null` is exactly right and is exactly why `uploadStall` treats a null attempt as "queued",
        // not "abandoned": otherwise every fresh drop would flag itself the instant it appeared.
        lastAttemptAt: null,
        error: null,
        failureKind: null,
        depositId: null, // the daemon mints the batch; the post-runFinished reread carries its id
        sourcePath: it.sourcePath ?? null, // remembered so a failed upload can be retried
      }));
      if (rows.length === 0) return [];
      // Optimistic only — instant `uploading` feedback. The caller fires the REAL daemon `deposit`; its ack
      // names the batch (`depositAccepted`) and its run's events drive the truth: on that run's runFinished
      // the read past it carries the archived files (✓) or the failures, and these rows go. If the deposit
      // COMMAND itself rejects (e.g. a stale daemon), the caller flips them ⚠ with the reason instead. We
      // never fake-settle to `frozen` on a timer.
      add({ kind: "deposit", rows, depositId: null });
      return rows.map((r) => r.id);
    },
    [add],
  );

  const depositAccepted = useCallback((ids: string[], depositId: string): void => {
    if (ids.length === 0) return;
    setOps((prev) => acceptDeposit(prev, ids, depositId, () => ++opSeq));
  }, []);

  const setDepositStatus = useCallback(
    (ids: string[], status: FileStatus, reason: string | null = null): OpHandle => {
      // A row flipped to `failed` from here is a command the daemon refused outright — a fault that won't
      // fix itself by retrying the same way, i.e. `permanent`, with the rejection as its detail.
      const patch: Partial<ArchivedFile> = { status, error: reason, failureKind: status === "failed" ? "permanent" : null };
      return add({ kind: "patch", byId: Object.fromEntries(ids.map((id) => [id, patch])) }).handle;
    },
    [add],
  );

  const rename = useCallback(
    (target: RowTarget, newName: string): OpHandle => add({ kind: "rename", target, name: newName.trim() }).handle,
    [add],
  );

  const move = useCallback(
    (targets: RowTarget[], toDir: string): OpHandle => add({ kind: "move", targets, toDir }).handle,
    [add],
  );

  // Optimistic drop; the view fires the real `deletePath` (a journal tombstone — byte reclamation is
  // deferred, 180-day min + repack). The read past its ack confirms it (tombstones are excluded there).
  const remove = useCallback((targets: RowTarget[]): OpHandle => add({ kind: "remove", targets }).handle, [add]);

  const newFolder = useCallback(
    (intoDir: string): { path: string; handle: OpHandle } => {
      // Pick a unique "untitled folder N" within intoDir.
      const siblings = new Set([
        ...overlaid.files.filter((f) => parentOf(f.relativePath) === intoDir).map((f) => baseName(f.relativePath)),
        ...overlaid.folders.filter((p) => parentOf(p) === intoDir).map(baseName),
      ]);
      let name = "untitled folder";
      for (let i = 2; siblings.has(name); i++) name = `untitled folder ${i}`;
      const path = joinPath(intoDir, name);
      return { path, handle: add({ kind: "newFolder", path }).handle };
    },
    [add, overlaid],
  );

  return {
    files,
    virtualFolders: overlaid.folders,
    deposit,
    depositAccepted,
    setDepositStatus,
    rename,
    move,
    remove,
    newFolder,
  };
};
