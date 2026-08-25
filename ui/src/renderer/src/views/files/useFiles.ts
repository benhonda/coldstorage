/**
 * The file-browser state + reorganize ops — the renderer's view of the vault tree.
 *
 * The flat tree is the daemon's `listFiles` (journal-backed), passed in as `daemonFiles` and held in
 * local state so the reorganize ops can edit it optimistically. deposit/move/rename/delete each apply an
 * OPTIMISTIC local edit here (instant feedback) while the view fires the REAL daemon command (`deposit` /
 * `movePath` / `deletePath`); the daemon's `filesChanged`/`runFinished` event then triggers a `listFiles`
 * refetch that reconciles this local copy to journal truth. The optimistic edit is exact (a move/rename
 * genuinely IS a cheap journal `relativePath` edit, no S3/no thaw), so the refetch is a no-op in the happy
 * path and the authoritative correction if anything diverged.
 *
 * Transfer status IS real: request-back calls the daemon's `requestRestore`, which writes a durable
 * journal row; the daemon's run loop drives it and the app READS the list (`listRestores`). We overlay
 * the newest transfer per file here, so a file the user asked back shows `pending` (deep storage is
 * waking up) / `transferring` (bytes moving) / `here` (saved) in the tree. Pass the store's `restores` in.
 * A download that ISN'T moving — unpaid, or stalled — deliberately overlays nothing; see `applyRestore`.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
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
  reparent,
  rewritePrefix,
  uploadStall,
  withName,
} from "./model.ts";

let depositSeq = 0;
/** An optimistic row's id — one the daemon has never seen. A retry on such a row can't go through
 * `retryFiles` (no journal row to requeue); it re-issues the original `deposit` from the dropped path. */
const OPTIMISTIC_PREFIX = "dep-";
const optimisticId = (stamp: number, i: number): string => `${OPTIMISTIC_PREFIX}${stamp}-${i}`;
export const isOptimisticId = (id: string): boolean => id.startsWith(OPTIMISTIC_PREFIX);

export interface FilesApi {
  /** The flat file list with live restore status overlaid — the browser renders the tree from this. */
  files: ArchivedFile[];
  /** Just-created, still-empty folders (virtual paths) to surface alongside the derived tree. */
  virtualFolders: string[];
  /** Add optimistic "uploading" rows for dropped items in `intoDir` (each carrying its local `sourcePath` for
   * retry, and its byte `size` where known — file drops know it up front, photo picks don't until the
   * daemon resolves them); returns their ids so the caller can flip status ({@link setDepositStatus}) as
   * the real `deposit` command resolves. The `size` feeds the deposit gate's in-flight accounting, so an
   * uploading row counts against the quota before its bytes ever land in S3 (see `state/entitlement.ts`). */
  deposit: (items: { name: string; sourcePath?: string; size?: number }[], intoDir: string) => string[];
  /** Set optimistic deposit rows' status (uploading ⇄ failed) by id — drives the retry cycle and keeps a
   * failed upload visible ON the file (⚠ couldn't upload) rather than vanishing or stuck on "uploading".
   *
   * `reason` rides along so the ⚠ can say WHY, the same as a journal-backed failure now does. Without it the
   * most immediate failure — the deposit you just asked for, rejected a second ago — would be the one with
   * no explanation, while a background fault from an hour ago had one. Passing `null` (a retry going back to
   * "uploading") clears it, for the reason every sibling clears on success. */
  setDepositStatus: (ids: string[], status: FileStatus, reason?: string | null) => void;
  /** Rename a file or folder (journal basename edit / prefix sweep). */
  rename: (target: RowTarget, newName: string) => void;
  /** Move files/folders under `toDir` (journal re-parent / prefix sweep — no S3, no thaw). */
  move: (targets: RowTarget[], toDir: string) => void;
  /** Tombstone files/folders (drops from the tree; bytes aren't reclaimed — see delete copy). */
  remove: (targets: RowTarget[]) => void;
  /** Create an empty folder under `intoDir`; returns its path so the caller can inline-rename it. */
  newFolder: (intoDir: string) => string;
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
): FilesApi => {
  const [base, setBase] = useState<ArchivedFile[]>(daemonFiles);
  // Empty folders, now journal-backed (status `folder` markers, fed in as `persistedFolders`). Held in
  // local state so the reorganize ops can edit them optimistically; adopted from the daemon on each read.
  const [virtualFolders, setVirtualFolders] = useState<string[]>(persistedFolders);

  // The daemon's `listFiles` is the source of truth — adopt each (re)read. Optimistic local ops
  // (deposit/move/rename/delete) edit `base` until the daemon supports them, then are reconciled to
  // this truth on the next read (a no-op once those commands persist their edits to the journal).
  useEffect(() => {
    setBase(daemonFiles);
  }, [daemonFiles]);

  // Same adopt-on-read for empty folders: `newFolder` adds optimistically + fires the REAL `createFolder`,
  // move/rename/delete edit optimistically + fire `movePath`/`deletePath` (which sweep the marker by path);
  // the next `listFiles` reconciles to journal truth (now a no-op in the happy path — the folder persists).
  useEffect(() => {
    setVirtualFolders(persistedFolders);
  }, [persistedFolders]);

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
    return base.map((file) => applyUpload(applyRestore(file, newestByFile.get(file.id), now, staleAfter), now, staleAfter));
  }, [base, newestByFile, staleAfter]);

  const deposit = useCallback((items: { name: string; sourcePath?: string; size?: number }[], intoDir: string): string[] => {
    const stamp = ++depositSeq;
    const added: ArchivedFile[] = items.map((it, i) => ({
      id: optimisticId(stamp, i),
      relativePath: joinPath(intoDir, it.name),
      // Real size where the caller knows it (a file drop) so this row counts against the quota while it
      // uploads; 0 when unknown (a photo pick, resolved daemon-side) — the daemon's usage read catches
      // those up on the next refresh. The authoritative size replaces this on the post-runFinished reread.
      size: it.size ?? 0,
      status: "uploading",
      kind: kindFromName(it.name),
      date: null,
      // Nothing has tried this yet — it was dropped a moment ago and the deposit command is still in
      // flight. `null` is exactly right and is exactly why `uploadStall` treats a null attempt as "queued",
      // not "abandoned": otherwise every fresh drop would flag itself the instant it appeared.
      lastAttemptAt: null,
      error: null,
      sourcePath: it.sourcePath ?? null, // remembered so a failed upload can be retried
    }));
    if (added.length === 0) return [];
    setBase((prev) => [...prev, ...added]);
    // Optimistic only — instant `uploading` feedback. The caller fires the REAL daemon `deposit`; its
    // events drive the truth: on runFinished the next `listFiles` replaces these rows with the archived
    // files (✓) or a failure surfaces (blobFailed → the "couldn't upload" panel). If the deposit COMMAND
    // itself rejects (e.g. a stale daemon), the caller rolls these back via `dropOptimistic` so we never
    // leave a fake `uploading` row. We never fake-settle to `frozen` on a timer.
    return added.map((a) => a.id);
  }, []);

  const setDepositStatus = useCallback((ids: string[], status: FileStatus, reason: string | null = null): void => {
    if (ids.length === 0) return;
    const set = new Set(ids);
    setBase((prev) => prev.map((f) => (set.has(f.id) ? { ...f, status, error: reason } : f)));
  }, []);

  const rename = useCallback((target: RowTarget, newName: string): void => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    if (target.kind === "file") {
      setBase((prev) =>
        prev.map((f) => (f.id === target.id ? { ...f, relativePath: withName(f.relativePath, trimmed) } : f)),
      );
    } else {
      const dest = withName(target.path, trimmed);
      setBase((prev) => prev.map((f) => ({ ...f, relativePath: rewritePrefix(f.relativePath, target.path, dest) })));
      setVirtualFolders((prev) => prev.map((p) => rewritePrefix(p, target.path, dest)));
    }
  }, []);

  const move = useCallback((targets: RowTarget[], toDir: string): void => {
    setBase((prev) =>
      prev.map((f) => {
        for (const t of targets) {
          if (t.kind === "file" && f.id === t.id) return { ...f, relativePath: reparent(f.relativePath, toDir) };
          if (t.kind === "folder") {
            const dest = reparent(t.path, toDir);
            if (f.relativePath === t.path || f.relativePath.startsWith(`${t.path}/`))
              return { ...f, relativePath: rewritePrefix(f.relativePath, t.path, dest) };
          }
        }
        return f;
      }),
    );
    setVirtualFolders((prev) =>
      prev.map((p) => {
        for (const t of targets) if (t.kind === "folder") p = rewritePrefix(p, t.path, reparent(t.path, toDir));
        return p;
      }),
    );
  }, []);

  const remove = useCallback((targets: RowTarget[]): void => {
    const fileIds = new Set(targets.filter((t) => t.kind === "file").map((t) => (t as { id: string }).id));
    const folders = targets.filter((t) => t.kind === "folder").map((t) => t.path);
    const underAFolder = (path: string): boolean =>
      folders.some((dir) => path === dir || path.startsWith(`${dir}/`));
    // Optimistic drop; the view fires the real `deletePath` (a journal tombstone — byte reclamation is
    // deferred, 180-day min + repack). The next `listFiles` confirms it (tombstones are excluded there).
    setBase((prev) => prev.filter((f) => !fileIds.has(f.id) && !underAFolder(f.relativePath)));
    setVirtualFolders((prev) => prev.filter((p) => !folders.includes(p) && !underAFolder(p)));
  }, []);

  const newFolder = useCallback(
    (intoDir: string): string => {
      // Pick a unique "untitled folder N" within intoDir.
      const siblings = new Set([
        ...base.filter((f) => parentOf(f.relativePath) === intoDir).map((f) => baseName(f.relativePath)),
        ...virtualFolders.filter((p) => parentOf(p) === intoDir).map(baseName),
      ]);
      let name = "untitled folder";
      for (let i = 2; siblings.has(name); i++) name = `untitled folder ${i}`;
      const path = joinPath(intoDir, name);
      setVirtualFolders((prev) => [...prev, path]);
      return path;
    },
    [base, virtualFolders],
  );

  return { files, virtualFolders, deposit, setDepositStatus, rename, move, remove, newFolder };
};
