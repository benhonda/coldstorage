/**
 * The file-browser state + reorganize ops — the renderer's view of the vault tree.
 *
 * WHY local state: the tree lives in the journal, and the daemon doesn't expose it yet (`listFiles`,
 * deposit, move/rename/delete are the open contract gaps — see ELECTRON-UI-DESIGN.md). So the flat
 * list is seeded from {@link fixtureFiles} and the ops mutate it optimistically. This is honest to the
 * real design: a move/rename/delete genuinely IS a cheap journal `relativePath` edit (no S3, no thaw),
 * so the optimistic edit mirrors what the daemon command will do. Each op marks its daemon seam.
 *
 * Live restore status IS real, though: request-back calls the daemon's `restore` command, and the
 * `restore*` events fold into the store's `restores` — which we overlay here so a file the user asks
 * back shows `getting back` / `here` in the tree. (Pass the store's `restores` in.)
 */
import { useCallback, useMemo, useRef, useState } from "react";
import type { RestoreActivity } from "../../state/reducer.ts";
import {
  type ArchivedFile,
  type RowTarget,
  baseName,
  joinPath,
  kindFromName,
  parentOf,
  reparent,
  rewritePrefix,
  withName,
} from "./model.ts";
import { fixtureFiles } from "./fixtures.ts";

/** How long an optimistic deposit shows `uploading` before settling to `frozen` (UI demo of the flow). */
const UPLOADING_DEMO_MS = 2200;

let depositSeq = 0;

export interface FilesApi {
  /** The flat file list with live restore status overlaid — the browser renders the tree from this. */
  files: ArchivedFile[];
  /** Just-created, still-empty folders (virtual paths) to surface alongside the derived tree. */
  virtualFolders: string[];
  /** Archive dropped items into `intoDir` (optimistic; real ingest is the daemon's deposit command). */
  deposit: (names: string[], intoDir: string) => number;
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

export const useFiles = (restores: Record<string, RestoreActivity>): FilesApi => {
  const [base, setBase] = useState<ArchivedFile[]>(fixtureFiles);
  const [virtualFolders, setVirtualFolders] = useState<string[]>([]);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  // Overlay live restore status by file id — keeps the tree truthful as a real thaw progresses.
  const files = useMemo(() => base.map((file) => applyRestore(file, restores[file.id])), [base, restores]);

  const deposit = useCallback((names: string[], intoDir: string): number => {
    const stamp = ++depositSeq;
    const added: ArchivedFile[] = names.map((name, i) => ({
      id: `dep-${stamp}-${i}`,
      relativePath: joinPath(intoDir, name),
      size: 0, // real size lands with the daemon's deposit; unknown at drop time
      status: "uploading",
      kind: kindFromName(name),
      date: null,
    }));
    if (added.length === 0) return 0;
    setBase((prev) => [...prev, ...added]);
    // SEAM: real ingest = resolve dropped paths via webUtils.getPathForFile (preload, Electron 32+),
    // then a daemon one-shot `deposit` command. Here we just settle the optimistic rows to `frozen`.
    const ids = new Set(added.map((a) => a.id));
    const t = setTimeout(() => {
      setBase((prev) => prev.map((f) => (ids.has(f.id) ? { ...f, status: "frozen" } : f)));
    }, UPLOADING_DEMO_MS);
    timers.current.push(t);
    return added.length;
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
    // SEAM: real delete = daemon `delete` tombstone; byte reclamation is deferred (180-day min + repack).
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

  return { files, virtualFolders, deposit, rename, move, remove, newFolder };
};
