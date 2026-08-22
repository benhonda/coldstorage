/**
 * The file-browser domain model — a PURE, headless-testable layer (no React, no daemon). The browser
 * renders a *reorganizable filesystem* whose tree lives in the journal, NOT in S3 keys: a folder is
 * derived from file paths, a move is a `relativePath` edit, the encrypted blob never moves. This module
 * holds that derivation (flat files → the rows at one directory) and the pure reorganize ops.
 *
 * The flat file list comes from the daemon's `listFiles` read (journal-backed); {@link fileFromJournal}
 * maps each raw wire row ({@link ListedFile}) into the {@link ArchivedFile} the browser draws.
 */
import type { ConflictPolicy, ListedFile } from "../../../../shared/ipc.ts";

/**
 * Per-file state — the journal `FileStatus` folded with the file's live transfer, if it has one.
 * - `frozen` — stored in deep storage (the common at-rest state; shows a quiet ✓).
 * - `uploading` — in the upload pipeline, incl. a transient retry (the daemon/SDK keep trying).
 * - `failed` — upload couldn't complete and the daemon stopped retrying (permanent/stuck) — needs
 *   attention. Transient blips are NOT this; they stay `uploading` until they self-heal or go permanent.
 * - `pending` / `transferring` / `here` — transfer activity, overlaid from the daemon's restores list.
 *
 * `pending` and `transferring` are two states because they are two different things, and conflating them
 * was a lie the UI told for a month: a Deep Archive thaw takes ~48 hours during which NOTHING moves, and
 * calling that "Transferring" left people watching a transfer that never budged. `pending` = deep storage
 * is waking up; `transferring` = bytes are actually moving. (`gettingBack`, which meant both, is gone.)
 */
export type FileStatus =
  | "frozen"
  | "uploading"
  /** Queued or retrying, but nothing is getting anywhere — see {@link uploadStall}. Distinct from `failed`
   * on purpose: `failed` is a permanent fault the daemon has stopped retrying, this one is still in the
   * queue. Same distinction, and the same reason for it, as a stalled download vs a failed one. */
  | "stalled"
  | "failed"
  | "pending"
  | "transferring"
  | "here";

/** Is this file's upload still OUTSTANDING — queued, in flight, or stuck but still going to be retried?
 *
 * `stalled` is a presentation refinement of `uploading`, not a different fate: the journal still has the
 * file as `planned` and the run loop will keep attempting it. So every question of the form "are these
 * bytes still coming?" must answer yes to both, and this exists so that can't be got wrong twice. The
 * deposit gate's in-flight accounting is the one that bites: counting only `uploading` let a stalled file
 * drop out of the quota, which is exactly how the vault sails past its limit (see App.tsx's `inFlightBytes`).
 */
export const isUploadOutstanding = (status: FileStatus): boolean =>
  status === "uploading" || status === "stalled";

/** Why an upload has stopped being something the tree can call "Uploading". Two causes, said differently:
 * one is a snag we're working through, the other is silence. Deliberately mirrors `RestoreStall` — same
 * question on the other half of the product. */
export type UploadStall =
  /** Attempts are happening and failing — `error` names the snag, and the daemon keeps retrying. */
  | "retrying"
  /** Nothing has tried in longer than the daemon's own window (or ever). */
  | "unattended";

/**
 * Has this file's upload stopped getting anywhere? `null` while it's fine — queued and being worked, or in
 * a state that isn't an upload at all.
 *
 * `staleAfterSeconds` is the daemon's own number (`Status.staleAfterSeconds`), the same one the Downloads
 * page reads, so both halves of the app measure silence against the loop's real beat rather than against a
 * constant either of them invented.
 *
 * A file with an `error` is "retrying" even if it was tried a second ago: it IS being attended to, and the
 * row should say what's wrong rather than pretend the queue is healthy.
 *
 * **A null `lastAttemptAt` is NOT a stall here** — the opposite of how the download side reads a null
 * `lastStepAt`, and the asymmetry is real rather than an oversight. A restore row is created by an explicit
 * user request and then handed to the run loop, so "never stepped" means the loop isn't running on
 * something someone just paid for. A `planned` file is created BY the loop, mid-pass, moments before it
 * attempts it — so null is the ordinary transient state of a freshly queued file, and calling that stalled
 * would flag every new deposit. It resolves either way on the pass that is already underway.
 */
export const uploadStall = (
  f: ArchivedFile,
  now: number,
  staleAfterSeconds: number,
): UploadStall | null => {
  if (f.status !== "uploading") return null;
  if (f.error !== null) return "retrying";
  if (f.lastAttemptAt !== null && now - f.lastAttemptAt > staleAfterSeconds) return "unattended";
  return null;
};

/** Coarse type, drives the row icon (and, when R2 lands, whether a thumbnail exists). */
export type FileKind = "photo" | "video" | "audio" | "document" | "archive" | "other";

/** One archived file — the journal row the browser draws. Mirrors the future `listFiles` element. */
export interface ArchivedFile {
  /** Stable file id = the journal key; also the `file` param of the `requestRestore` control command. */
  id: string;
  /** POSIX path relative to the vault root, e.g. "Photos/2019/beach.jpg". The journal SSOT for the tree. */
  relativePath: string;
  /** Size in bytes. */
  size: number;
  status: FileStatus;
  kind: FileKind;
  /** Archived/modified instant (ISO), or null if the journal doesn't expose one. */
  date: string | null;
  /** Unix seconds the upload path last tried this file; null if it never has. Feeds {@link uploadStall}. */
  lastAttemptAt: number | null;
  /** Why the last upload attempt failed, or null — shown on the row rather than left in the journal. */
  error: string | null;
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
  /** Aggregate status (active wins: uploading ▸ transferring ▸ pending ▸ here-if-all ▸ frozen). */
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

/** The reorganize target a row points at. `path` is the FULL vault-relative path for both kinds — it's
 * the `from`/`path` argument of the daemon's `movePath`/`deletePath` commands. */
export const targetOf = (row: Row): RowTarget =>
  row.type === "folder"
    ? { kind: "folder", path: row.path }
    : { kind: "file", id: row.file.id, path: row.file.relativePath };

/** A row's status — the folder rollup or the file's own — for the always-visible badge. */
export const rowStatus = (row: Row): FileStatus => (row.type === "folder" ? row.status : row.file.status);

/** A just-created folder with nothing under it yet — no upload status applies (nothing to store), so the
 * row shows no badge. */
export const isEmptyFolder = (row: Row): boolean => row.type === "folder" && row.empty;

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

/**
 * Finder-style "Keep Both" name: the first free `dir/stem N.ext` (a space, then 2, 3, …) not in `taken`.
 * Mirrors Swift `CollisionResolvingSource.uniquify` — the daemon is authoritative, this only drives the
 * optimistic row name (reconciled on the next `listFiles` read). A leading-dot leaf (`.gitignore`) is
 * all-stem, no extension (dot must be past index 0), matching the daemon + Finder.
 */
export const uniquifyPath = (path: string, taken: ReadonlySet<string>): string => {
  const slash = path.lastIndexOf("/");
  const dir = slash >= 0 ? path.slice(0, slash) : "";
  const leaf = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = leaf.lastIndexOf(".");
  const stem = dot > 0 ? leaf.slice(0, dot) : leaf;
  const ext = dot > 0 ? leaf.slice(dot) : "";
  for (let n = 2; ; n++) {
    const candidate = joinPath(dir, `${stem} ${n}${ext}`);
    if (!taken.has(candidate)) return candidate;
  }
};

/** One row a deposit will actually create after collision resolution. `relativePath` is where it shows
 *  (renamed for keepBoth); `original` is the previewed path the daemon keys the policy on. */
export interface DepositPlanItem {
  relativePath: string;
  original: string;
}

/**
 * Apply the user's per-file collision choices to a previewed deposit. Returns the rows that will actually
 * land (skips dropped, keepBoth renamed via {@link uniquifyPath}) plus the `conflicts` map to hand the
 * daemon (vault relativePath → policy). Non-colliding items always pass through. Pure — drives both the
 * optimistic rows and the wire param, and is unit-tested in isolation.
 */
export const planDeposit = (
  preview: readonly { relativePath: string; exists: boolean }[],
  policies: Readonly<Record<string, ConflictPolicy>>,
  liveTreePaths: ReadonlySet<string>,
): { rows: DepositPlanItem[]; conflicts: Record<string, ConflictPolicy> } => {
  const policyOf = (p: { relativePath: string; exists: boolean }): ConflictPolicy | undefined =>
    p.exists ? policies[p.relativePath] : undefined;
  const taken = new Set(liveTreePaths);
  // Pre-seed every item that KEEPS its path this run (new files + replace), so a keepBoth rename dodges a
  // same-drop sibling that hasn't been processed yet — mirrors the daemon's CollisionResolvingSource.
  for (const p of preview) {
    const policy = policyOf(p);
    if (policy !== "skip" && policy !== "keepBoth") taken.add(p.relativePath);
  }
  const rows: DepositPlanItem[] = [];
  const conflicts: Record<string, ConflictPolicy> = {};
  for (const p of preview) {
    const policy = policyOf(p);
    if (policy === "skip") {
      conflicts[p.relativePath] = "skip";
      continue;
    }
    if (policy === "keepBoth") {
      conflicts[p.relativePath] = "keepBoth";
      const renamed = uniquifyPath(p.relativePath, taken);
      taken.add(renamed);
      rows.push({ relativePath: renamed, original: p.relativePath });
    } else {
      if (policy === "replace") conflicts[p.relativePath] = "replace";
      rows.push({ relativePath: p.relativePath, original: p.relativePath });
    }
  }
  return { rows, conflicts };
};

/** The parent directory of a path ("a/b/c" → "a/b"; "a" → ""). */
export const parentOf = (path: string): string => segments(path).slice(0, -1).join("/");

/** Is `path` inside `dir` (or equal to it)? Root ("") contains everything. */
export const isUnder = (path: string, dir: string): boolean =>
  dir === "" || path === dir || path.startsWith(`${dir}/`);

/** Can `targets` legally land under `toDir`? A folder can't move into itself or its own subtree
 * (mirrors the daemon's own `movePath` guard); files can go anywhere. Shared by the drag-to-move
 * gesture and the "Move to…" picker so both offer exactly the same destinations. */
export const canMoveInto = (targets: readonly RowTarget[], toDir: string): boolean =>
  !targets.some((t) => t.kind === "folder" && isUnder(toDir, t.path));

/** Would moving `targets` under `toDir` change nothing — every target already lives directly in it?
 * A no-op drop isn't offered as a drag target (Finder-style: dropping back where it came from does
 * nothing, so it never lights up). */
export const moveIsNoop = (targets: readonly RowTarget[], toDir: string): boolean =>
  targets.every((t) => parentOf(t.path) === toDir);

/**
 * Rollup for a folder's aggregate status. `failed` wins first — a stuck upload inside is the thing that
 * won't resolve itself, so the folder flags it so the user can drill in and find it. Then the active
 * states, then all-here, else `frozen` (stored).
 *
 * `transferring` outranks `pending`: if anything under this folder is actually moving bytes, that's the
 * more specific truth, and the folder should not read as merely waiting.
 */
const rollupStatus = (s: Set<FileStatus>): FileStatus =>
  s.has("failed")
    ? "failed"
    : // A stalled upload inside outranks a healthy one: "some of this folder is moving" is the less useful
      // truth when part of it has stopped, and the folder is how the user finds the file to act on.
      s.has("stalled")
      ? "stalled"
      : s.has("uploading")
      ? "uploading"
      : s.has("transferring")
        ? "transferring"
        : s.has("pending")
          ? "pending"
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

/**
 * The vault path prefix to strip when saving a restore to the Mac: the deepest folder that CONTAINS
 * everything asked for. Finder's rule — copy a folder and you get the folder, copy files and you get the
 * files.
 *
 * This exists because requesting a folder back used to flatten it (2026-07-27). Every file in the request
 * was saved as `<chosen folder>/<basename>`, so a folder of 300 photos landed as 300 loose files in
 * Downloads, and any two that shared a name in different subfolders overwrote each other on the way in.
 * The structure was in the vault the whole time; the destination path just threw it away.
 *
 * Each target contributes its PARENT, so:
 *   - the folder `Photos`             → parent `""`       → base `""`     → saves `Photos/2019/beach.jpg`
 *   - the file  `Photos/beach.jpg`    → parent `Photos`   → base `Photos` → saves `beach.jpg`
 *   - two files in `Photos`           → base `Photos`     → both save flat, as before
 *   - a mix under different folders   → base `""`         → each keeps its own path, so they can't collide
 */
export const restoreBase = (targets: readonly RowTarget[]): string =>
  commonParent(targets.map((t) => t.path));

/**
 * The deepest folder that is an ancestor of EVERY given path — each path contributes its parent, so a
 * lone "Photos/a.jpg" yields "Photos" and a lone "Photos" (as a target path) yields "". This is the walk
 * behind {@link restoreBase}, exported on its own because the Downloads page's request grouping asks the
 * same question of a request's vault paths (its display name) and destination paths (its reveal folder).
 *
 * Unlike {@link parentOf}/{@link segments} (vault-relative only), this preserves a leading "/" — an
 * absolute path's root arrives as an empty first segment and survives the join — so it serves both path
 * kinds. Empty input → "".
 */
export const commonParent = (paths: readonly string[]): string => {
  const [first, ...rest] = paths.map((p) => {
    const cut = p.lastIndexOf("/");
    const parent = cut > 0 ? p.slice(0, cut) : "";
    return parent === "" ? [] : parent.split("/");
  });
  let common = first ?? [];
  for (const segs of rest) {
    let i = 0;
    while (i < common.length && i < segs.length && common[i] === segs[i]) i++;
    common = common.slice(0, i);
  }
  return common.join("/");
};

/**
 * Where a vault file lands on this Mac: its path with `base` stripped, under the chosen save folder.
 *
 * Falls back to the basename for a file that isn't under `base` at all. That shouldn't happen (the base is
 * derived from the same targets the files were expanded from), but the alternative to a guard is a path
 * built from a negative slice — which silently writes somewhere nobody asked for.
 */
export const restoreOutPath = (relativePath: string, base: string, destDir: string): string => {
  if (base === "") return `${destDir}/${relativePath}`;
  const rel = isUnder(relativePath, base) ? relativePath.slice(base.length + 1) : baseName(relativePath);
  return `${destDir}/${rel}`;
};

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

/** Live determinate upload progress for one file (the value side of the store's `run.uploadProgress`).
 *
 * RETAINED, CURRENTLY UNRENDERED. The daemon still emits this per-file byte signal (`onProgress` in the
 * upload engine, for large solo-blob files) and the store still folds it — but no view draws it today: the
 * uploading row dropped its per-file determinate bar for a plain spinner (progress now lives once, in the
 * top deposit banner). Kept deliberately as a latent capability (e.g. a per-file detail view) — NOT dead
 * code to wire back into the row. See `DepositProgress` and `MyFilesView`'s row render. */
export interface UploadProgress {
  /** relativePath the daemon reported — the match key for an optimistic (pre-archive) drop row. */
  path: string;
  uploaded: number;
  total: number;
}

/**
 * The upload percent (0–100) for one file, or null when there's no determinate signal for it. Matches the
 * daemon's `uploadProgress` entries to a file by EITHER its journal id or its relativePath — they diverge
 * for Photos (id = localIdentifier) and for an optimistic drop row (synthetic id, real path). Only large
 * (solo-blob) files ever have an entry; everything else → null.
 *
 * RETAINED, CURRENTLY UNRENDERED — this backed the old per-row determinate bar, which is gone (see
 * {@link UploadProgress}). Still unit-tested and correct; kept for a future per-file progress surface.
 */
export const uploadPercent = (
  progress: Record<string, UploadProgress>,
  file: { id: string; relativePath: string },
): number | null => {
  const e = progress[file.id] ?? Object.values(progress).find((p) => p.path === file.relativePath);
  if (!e || e.total <= 0) return null;
  return Math.min(100, Math.max(0, Math.round((e.uploaded / e.total) * 100)));
};

/**
 * Coarsen the daemon's raw journal `FileStatus` to the browser's status. `pending`/`transferring`/`here`
 * are NOT journal file states — they're overlaid from the daemon's restores list (see useFiles), never
 * produced here.
 * The journal persists `planned` (queued), `archived` (at rest), and `failed` (a permanent upload fault —
 * the daemon stopped retrying and marked the file, so the ⚠ row is journal truth that survives a refresh
 * and a restart); the remaining states are mapped forward-looking. `failed` → `failed` (needs attention).
 * A blob's *transient* failure does NOT mark its files — they stay `planned`/`uploading` and retry.
 */
const STATUS_FROM_JOURNAL: Record<string, FileStatus> = {
  archived: "frozen", // at rest in deep storage — the resting state (a quiet ✓)
  discovered: "uploading",
  planned: "uploading",
  uploading: "uploading",
  verifying: "uploading",
  failed: "failed",
};

/**
 * A folder-marker row — the journal's `folder`-status anchor for a just-created EMPTY folder (so it
 * survives a reload; the tree is otherwise derived from file paths). Its `relativePath` is the folder
 * path. Markers are NOT files: split them out of `listFiles` and feed their paths into the browser's
 * `virtualFolders` channel instead (see App + useFiles), so the tree derivation needs no special-casing.
 */
export const isFolderMarker = (row: ListedFile): boolean => row.status === "folder";

/**
 * Map a raw `listFiles` row to the {@link ArchivedFile} the browser draws. `date` is the journal's capture
 * time (epoch seconds) rendered to an ISO string for {@link formatDate}; null when the journal has none
 * (legacy rows predating the column → "—"). `kind` is derived from the name.
 */
export const fileFromJournal = (row: ListedFile): ArchivedFile => ({
  id: row.id,
  relativePath: row.relativePath,
  size: row.size,
  status: STATUS_FROM_JOURNAL[row.status] ?? "uploading",
  kind: kindFromName(row.relativePath),
  date: row.date != null ? new Date(row.date * 1000).toISOString() : null,
  lastAttemptAt: row.lastAttemptAt,
  error: row.error,
});
