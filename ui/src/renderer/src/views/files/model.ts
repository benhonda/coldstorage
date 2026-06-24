/**
 * The file-browser domain model — a PURE, headless-testable layer (no React, no daemon). The browser
 * renders a *reorganizable filesystem* whose tree lives in the journal, NOT in S3 keys: a folder is
 * derived from file paths, a move is a `relativePath` edit, the encrypted blob never moves. This module
 * holds that derivation (flat files → the rows at one directory) and the pure reorganize ops.
 *
 * The flat file list comes from the daemon's `listFiles` read (journal-backed); {@link fileFromJournal}
 * maps each raw wire row ({@link ListedFile}) into the {@link ArchivedFile} the browser draws.
 */
import type { ListedFile } from "../../../../shared/ipc.ts";

/**
 * Per-file state — the journal `FileStatus` folded with live restore activity.
 * - `frozen` — stored in deep storage (the common at-rest state; shows a quiet ✓).
 * - `uploading` — in the upload pipeline, incl. a transient retry (the daemon/SDK keep trying).
 * - `failed` — upload couldn't complete and the daemon stopped retrying (permanent/stuck) — needs
 *   attention. Transient blips are NOT this; they stay `uploading` until they self-heal or go permanent.
 * - `gettingBack` / `here` — restore activity (a copy on its way / saved on this Mac), overlaid live.
 */
export type FileStatus = "frozen" | "uploading" | "failed" | "gettingBack" | "here";

/** Coarse type, drives the row icon (and, when R2 lands, whether a thumbnail exists). */
export type FileKind = "photo" | "video" | "audio" | "document" | "archive" | "other";

/** One archived file — the journal row the browser draws. Mirrors the future `listFiles` element. */
export interface ArchivedFile {
  /** Stable file id = the journal key; also the `file` param of the `restore` control command. */
  id: string;
  /** POSIX path relative to the vault root, e.g. "Photos/2019/beach.jpg". The journal SSOT for the tree. */
  relativePath: string;
  /** Size in bytes. */
  size: number;
  status: FileStatus;
  kind: FileKind;
  /** Archived/modified instant (ISO), or null if the journal doesn't expose one. */
  date: string | null;
  /** When `gettingBack`: quoted ready-by (ISO). */
  readyBy?: string | null;
  /** When `here`: the local path the thawed bytes landed at. */
  localPath?: string | null;
  /** For an optimistic (not-yet-uploaded) drop: the local absolute source path, so a failed upload can be
   * retried by re-issuing `deposit`. Null/absent for journal-backed files. UI-only — never from the daemon. */
  srcPath?: string | null;
}

/** A folder row — synthesized from the paths beneath it; size/count/status are rolled up. */
export interface FolderRow {
  type: "folder";
  name: string;
  /** Full path of this folder (e.g. "Photos/2019"). */
  path: string;
  /** Sum of descendant file bytes. */
  size: number;
  /** Descendant file count. */
  count: number;
  /** Aggregate status (active wins: uploading ▸ gettingBack ▸ here-if-all ▸ frozen). */
  status: FileStatus;
  /** True for a just-created, still-empty folder (virtual path, no files yet). */
  empty: boolean;
}

/** A file row at the current directory level. */
export interface FileLeafRow {
  type: "file";
  name: string;
  file: ArchivedFile;
}

export type Row = FolderRow | FileLeafRow;

/** A reorganize/select target — either a file (by id) or a folder (by path). Both carry the path. */
export type RowTarget = { kind: "file"; id: string; path: string } | { kind: "folder"; path: string };

/** Stable selection/React key for a row — namespaced so a file and a folder never collide. */
export const rowKey = (row: Row): string =>
  row.type === "folder" ? `folder:${row.path}` : `file:${row.file.id}`;

/** The reorganize target a row points at. */
export const targetOf = (row: Row): RowTarget =>
  row.type === "folder"
    ? { kind: "folder", path: row.path }
    : { kind: "file", id: row.file.id, path: joinPath("", row.name) };

/** A row's status — the folder rollup or the file's own — for the always-visible badge. */
export const rowStatus = (row: Row): FileStatus => (row.type === "folder" ? row.status : row.file.status);

/** Split a path into its non-empty segments. "" → []. */
export const segments = (p: string): string[] => p.split("/").filter(Boolean);

/** The basename (last segment) of a path. */
export const baseName = (path: string): string => segments(path).at(-1) ?? "";

/** Replace a path's basename: ("a/b/c", "d") → "a/b/d". */
export const withName = (path: string, name: string): string =>
  joinPath(parentOf(path), name);

/** Re-parent a path under `toDir`, keeping its basename: ("a/b/c", "x") → "x/c". */
export const reparent = (path: string, toDir: string): string => joinPath(toDir, baseName(path));

/**
 * Rewrite a descendant path when its ancestor folder moves/renames `oldPrefix` → `newPrefix`.
 * Leaves non-descendants untouched. ("a/b/c", "a/b", "x/y") → "x/y/c".
 */
export const rewritePrefix = (path: string, oldPrefix: string, newPrefix: string): string => {
  if (path === oldPrefix) return newPrefix;
  if (path.startsWith(`${oldPrefix}/`)) return newPrefix + path.slice(oldPrefix.length);
  return path;
};

/** Join a directory + name into a path ("" + "a" → "a"; "a" + "b" → "a/b"). */
export const joinPath = (dir: string, name: string): string => (dir ? `${dir}/${name}` : name);

/** The parent directory of a path ("a/b/c" → "a/b"; "a" → ""). */
export const parentOf = (path: string): string => segments(path).slice(0, -1).join("/");

/** Is `path` inside `dir` (or equal to it)? Root ("") contains everything. */
export const isUnder = (path: string, dir: string): boolean =>
  dir === "" || path === dir || path.startsWith(`${dir}/`);

/**
 * Rollup for a folder's aggregate status. `failed` wins first — a stuck upload inside is the thing that
 * won't resolve itself, so the folder flags it so the user can drill in and find it. Then active states
 * (uploading/gettingBack), then all-here, else `frozen` (stored).
 */
const rollupStatus = (s: Set<FileStatus>): FileStatus =>
  s.has("failed")
    ? "failed"
    : s.has("uploading")
      ? "uploading"
      : s.has("gettingBack")
        ? "gettingBack"
        : s.size === 1 && s.has("here")
          ? "here"
          : "frozen";

/**
 * The rows shown at directory `dir` (root = ""): immediate subfolders (aggregated) then files, each
 * sorted A–Z. `extraFolders` are virtual (just-created, still-empty) folder paths to surface even
 * though no file lives under them yet — the Finder "new folder" affordance.
 */
export const childrenOf = (
  files: readonly ArchivedFile[],
  dir: string,
  extraFolders: readonly string[] = [],
): Row[] => {
  const base = segments(dir);
  const folders = new Map<string, { size: number; count: number; statuses: Set<FileStatus> }>();
  const fileRows: FileLeafRow[] = [];

  for (const f of files) {
    const segs = segments(f.relativePath);
    if (segs.length <= base.length) continue; // not deep enough to live under `dir`
    if (base.some((seg, i) => segs[i] !== seg)) continue; // diverges from `dir`

    const rest = segs.slice(base.length);
    const head = rest[0];
    if (head === undefined) continue; // unreachable (rest is non-empty) — satisfies noUncheckedIndexedAccess
    if (rest.length === 1) {
      fileRows.push({ type: "file", name: head, file: f });
    } else {
      const agg = folders.get(head) ?? { size: 0, count: 0, statuses: new Set<FileStatus>() };
      agg.size += f.size;
      agg.count += 1;
      agg.statuses.add(f.status);
      folders.set(head, agg);
    }
  }

  // Virtual folders whose direct parent is `dir` and that have no real files yet.
  for (const vf of extraFolders) {
    if (parentOf(vf) !== dir) continue;
    const name = segments(vf).at(-1);
    if (name && !folders.has(name)) folders.set(name, { size: 0, count: 0, statuses: new Set() });
  }

  const folderRows: FolderRow[] = [...folders.entries()]
    .map(([name, agg]) => ({
      type: "folder" as const,
      name,
      path: joinPath(dir, name),
      size: agg.size,
      count: agg.count,
      status: rollupStatus(agg.statuses),
      empty: agg.count === 0,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  fileRows.sort((a, b) => a.name.localeCompare(b.name));
  return [...folderRows, ...fileRows];
};

/** Files at or beneath `dir` (root = all) — for whole-folder select / request-back / delete. */
export const filesUnder = (files: readonly ArchivedFile[], dir: string): ArchivedFile[] =>
  files.filter((f) => isUnder(f.relativePath, dir));

/** Every folder path implied by the files (+ any virtual folders), sorted — for a move-to picker. */
export const allFolderPaths = (
  files: readonly ArchivedFile[],
  extraFolders: readonly string[] = [],
): string[] => {
  const set = new Set<string>();
  for (const file of files) {
    const segs = segments(file.relativePath);
    for (let i = 1; i < segs.length; i++) set.add(segs.slice(0, i).join("/"));
  }
  for (const vf of extraFolders) set.add(vf);
  return [...set].sort((a, b) => a.localeCompare(b));
};

/** Total bytes across a set of files. */
export const totalBytes = (files: readonly ArchivedFile[]): number =>
  files.reduce((n, f) => n + f.size, 0);

const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/** Human-readable size, decimal. 0 → "0 B". */
export const formatBytes = (n: number): string => {
  if (n <= 0) return "0 B";
  const e = Math.min(UNITS.length - 1, Math.floor(Math.log(n) / Math.log(1000)));
  const v = n / 1000 ** e;
  // whole numbers for bytes/KB; one decimal for MB+ (but trim a trailing .0)
  const str = e <= 1 ? Math.round(v).toString() : v.toFixed(1).replace(/\.0$/, "");
  return `${str} ${UNITS[e]}`;
};

const EXT_KIND: Record<string, FileKind> = {
  jpg: "photo", jpeg: "photo", png: "photo", gif: "photo", heic: "photo", webp: "photo", tiff: "photo",
  mov: "video", mp4: "video", m4v: "video", avi: "video", mkv: "video",
  mp3: "audio", wav: "audio", aac: "audio", flac: "audio", m4a: "audio",
  pdf: "document", doc: "document", docx: "document", txt: "document", md: "document", pages: "document",
  zip: "archive", tar: "archive", gz: "archive", dmg: "archive", "7z": "archive",
};

/** Friendly date from an ISO string ("Mar 3 2024"); null/invalid → "—". */
export const formatDate = (iso: string | null): string => {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
};

/** Best-guess {@link FileKind} from a filename extension. */
export const kindFromName = (name: string): FileKind => {
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  return EXT_KIND[ext] ?? "other";
};

/**
 * Coarsen the daemon's raw journal `FileStatus` to the browser's status. `gettingBack`/`here` are NOT
 * journal states — they're overlaid live from restore activity (see useFiles), never produced here.
 * In practice the journal only persists `planned` (queued) and `archived` (at rest) per file today; the
 * rest are mapped forward-looking. `failed` → `failed` (needs attention) — but note the daemon doesn't
 * yet PERSIST a per-file `failed` status (failures are reported per-blob via the `blobFailed` event); see
 * ELECTRON-UI-DESIGN.md "Daemon contract gaps". So a per-row ⚠ lights up only once that contract lands;
 * until then, failures surface at the run/blob level (the sidebar "couldn't upload" panel).
 */
const STATUS_FROM_JOURNAL: Record<string, FileStatus> = {
  archived: "frozen", // at rest in deep storage — the resting state (a quiet ✓)
  discovered: "uploading",
  planned: "uploading",
  staging: "uploading",
  uploading: "uploading",
  verifying: "uploading",
  failed: "failed",
};

/**
 * Map a raw `listFiles` row to the {@link ArchivedFile} the browser draws. The journal carries no
 * timestamp on the `files` row today, so `date` is null (renders "—"); kind is derived from the name.
 */
export const fileFromJournal = (row: ListedFile): ArchivedFile => ({
  id: row.id,
  relativePath: row.relativePath,
  size: row.size,
  status: STATUS_FROM_JOURNAL[row.status] ?? "uploading",
  kind: kindFromName(row.relativePath),
  date: null,
});
