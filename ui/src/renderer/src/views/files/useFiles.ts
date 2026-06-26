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
 * Live restore status IS real: request-back calls the daemon's `restore` command, and the `restore*`
 * events fold into the store's `restores` — which we overlay here so a file the user asks back shows
 * `getting back` / `here` in the tree. (Pass the store's `restores` in.)
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { RestoreActivity } from "../../state/reducer.ts";
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
  withName,
} from "./model.ts";

let depositSeq = 0;

export interface FilesApi {
  /** The flat file list with live restore status overlaid — the browser renders the tree from this. */
  files: ArchivedFile[];
  /** Just-created, still-empty folders (virtual paths) to surface alongside the derived tree. */
  virtualFolders: string[];
  /** Add optimistic "uploading" rows for dropped items in `intoDir` (each carrying its local `srcPath` for
   * retry); returns their ids so the caller can flip status ({@link setDepositStatus}) as the real
   * `deposit` command resolves. */
  deposit: (items: { name: string; srcPath?: string }[], intoDir: string) => string[];
  /** Set optimistic deposit rows' status (uploading ⇄ failed) by id — drives the retry cycle and keeps a
   * failed upload visible ON the file (⚠ couldn't upload) rather than vanishing or stuck on "uploading". */
  setDepositStatus: (ids: string[], status: FileStatus) => void;
  /** Rename a file or folder (journal basename edit / prefix sweep). */
  rename: (target: RowTarget, newName: string) => void;
  /** Move files/folders under `toDir` (journal re-parent / prefix sweep — no S3, no thaw). */
  move: (targets: RowTarget[], toDir: string) => void;
  /** Tombstone files/folders (drops from the tree; bytes aren't reclaimed — see delete copy). */
  remove: (targets: RowTarget[]) => void;
  /** Create an empty folder under `intoDir`; returns its path so the caller can inline-rename it. */
  newFolder: (intoDir: string) => string;
}

/** Overlay live restore activity onto a base file (request-back makes this real, not a fixture). */
const applyRestore = (file: ArchivedFile, r: RestoreActivity | undefined): ArchivedFile => {
  if (!r) return file;
  if (r.state === "completed") return { ...file, status: "here", localPath: r.out ?? file.localPath ?? null };
  return { ...file, status: "gettingBack" };
};

export const useFiles = (
  daemonFiles: ArchivedFile[],
  persistedFolders: string[],
  restores: Record<string, RestoreActivity>,
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

  // Overlay live restore status by file id — keeps the tree truthful as a real thaw progresses.
  const files = useMemo(() => base.map((file) => applyRestore(file, restores[file.id])), [base, restores]);

  const deposit = useCallback((items: { name: string; srcPath?: string }[], intoDir: string): string[] => {
    const stamp = ++depositSeq;
    const added: ArchivedFile[] = items.map((it, i) => ({
      id: `dep-${stamp}-${i}`,
      relativePath: joinPath(intoDir, it.name),
      size: 0, // real size lands with the daemon's deposit; unknown at drop time
      status: "uploading",
      kind: kindFromName(it.name),
      date: null,
      srcPath: it.srcPath ?? null, // remembered so a failed upload can be retried
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

  const setDepositStatus = useCallback((ids: string[], status: FileStatus): void => {
    if (ids.length === 0) return;
    const set = new Set(ids);
    setBase((prev) => prev.map((f) => (set.has(f.id) ? { ...f, status } : f)));
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
