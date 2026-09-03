/**
 * Pending optimistic edits, as a pure overlay on the daemon's tree.
 *
 * The file browser edits the tree BEFORE the daemon confirms — a move, a rename, a delete, a new folder, a
 * drop's "uploading" rows — for instant feedback. The question is when such an edit may be let go of, and
 * the answer is NOT "on the next `listFiles`": replies don't arrive in execution order (a big `listFiles`
 * encodes long after a one-line `movePath` ack has gone out, and a read issued a beat before the edit can
 * land a beat after it). Letting the next read win put moved folders back where they came from for a beat,
 * and wiped in-flight upload rows outright (2026-09-03).
 *
 * So every edit is held here as an op, re-applied on top of EVERY read, until a read arrives whose tree
 * {@link PendingOp.until revision} is at or past the one the edit's ack named ({@link TreeAck}) — the first
 * read that provably reflects it. A drop's rows are held until the read past its run's end
 * (`runFinished.revision`, keyed by the batch id the deposit ack minted). A rejected command simply
 * removes its op — the tree snaps back to what the daemon has, which is the truth about a refused edit.
 *
 * Applying an op is idempotent over a tree that already reflects it (a move of a path that isn't there is a
 * no-op; a folder that already persists dedupes), which is what makes "re-apply on every read" safe in the
 * window between the daemon's edit and the read that shows it.
 *
 * Pure functions, no React — `useFiles` owns the state and the handles; this owns the semantics.
 */
import {
  type ArchivedFile,
  type RowTarget,
  reparent,
  rewritePrefix,
  withName,
} from "./model.ts";

/** The tree the browser renders from: the flat file list, plus empty folders (paths with nothing under them). */
export interface Tree {
  files: ArchivedFile[];
  folders: string[];
}

export type TreeOp =
  /** A drop's optimistic "uploading" rows. Each carries its exact vault path (the daemon's preview resolved
   * it), so a row overrides whatever the tree has at that path — for a Replace, the "uploading" row is the
   * truth about that path now, not the old ✓. `depositId` arrives with the ack; null until then. */
  | { kind: "deposit"; rows: ArchivedFile[]; depositId: string | null }
  /** Field edits on rows by id — the status flips a retry/rejection makes (uploading ⇄ failed, with reason). */
  | { kind: "patch"; byId: Record<string, Partial<ArchivedFile>> }
  | { kind: "rename"; target: RowTarget; name: string }
  | { kind: "move"; targets: RowTarget[]; toDir: string }
  | { kind: "remove"; targets: RowTarget[] }
  | { kind: "newFolder"; path: string };

export interface PendingOp {
  id: number;
  op: TreeOp;
  /** The tree revision at which the daemon reflects this edit (from its ack) — the op goes on the first
   * read at or past it. `null` while the command is still in flight. A deposit op ignores this and goes
   * by its run's end instead (see {@link prune}). */
  until: number | null;
}

/** Apply one op to a tree. Idempotent over a tree that already reflects it. */
export const applyOp = (tree: Tree, op: TreeOp): Tree => {
  switch (op.kind) {
    case "deposit": {
      const paths = new Set(op.rows.map((r) => r.relativePath));
      return { ...tree, files: [...tree.files.filter((f) => !paths.has(f.relativePath)), ...op.rows] };
    }
    case "patch":
      return { ...tree, files: tree.files.map((f) => (op.byId[f.id] ? { ...f, ...op.byId[f.id] } : f)) };
    case "rename": {
      const { target, name } = op;
      if (target.kind === "file") {
        return {
          ...tree,
          files: tree.files.map((f) => (f.id === target.id ? { ...f, relativePath: withName(f.relativePath, name) } : f)),
        };
      }
      const dest = withName(target.path, name);
      return {
        files: tree.files.map((f) => ({ ...f, relativePath: rewritePrefix(f.relativePath, target.path, dest) })),
        folders: tree.folders.map((p) => rewritePrefix(p, target.path, dest)),
      };
    }
    case "move": {
      const { targets, toDir } = op;
      return {
        files: tree.files.map((f) => {
          for (const t of targets) {
            if (t.kind === "file" && f.id === t.id) return { ...f, relativePath: reparent(f.relativePath, toDir) };
            if (t.kind === "folder" && (f.relativePath === t.path || f.relativePath.startsWith(`${t.path}/`)))
              return { ...f, relativePath: rewritePrefix(f.relativePath, t.path, reparent(t.path, toDir)) };
          }
          return f;
        }),
        folders: tree.folders.map((p) => {
          for (const t of targets) if (t.kind === "folder") p = rewritePrefix(p, t.path, reparent(t.path, toDir));
          return p;
        }),
      };
    }
    case "remove": {
      const fileIds = new Set(op.targets.flatMap((t) => (t.kind === "file" ? [t.id] : [])));
      const folders = op.targets.flatMap((t) => (t.kind === "folder" ? [t.path] : []));
      const underAFolder = (path: string): boolean => folders.some((dir) => path === dir || path.startsWith(`${dir}/`));
      return {
        files: tree.files.filter((f) => !fileIds.has(f.id) && !underAFolder(f.relativePath)),
        folders: tree.folders.filter((p) => !folders.includes(p) && !underAFolder(p)),
      };
    }
    case "newFolder":
      return tree.folders.includes(op.path) ? tree : { ...tree, folders: [...tree.folders, op.path] };
  }
};

/** The tree with every pending op on top, in the order they were made. */
export const applyOps = (base: Tree, ops: readonly PendingOp[]): Tree =>
  ops.reduce((tree, { op }) => applyOp(tree, op), base);

/**
 * The ops still worth holding at `revision`: everything the daemon hasn't provably reflected yet.
 * `depositRuns` maps a batch id to the revision its run finished at (`runFinished`) — a deposit op goes
 * once a read at or past that has landed, and not before: its rows are final only then.
 */
export const prune = (
  ops: readonly PendingOp[],
  revision: number,
  depositRuns: Readonly<Record<string, number>>,
): PendingOp[] =>
  ops.filter(({ op, until }) => {
    if (op.kind === "deposit") {
      const finishedAt = op.depositId === null ? undefined : depositRuns[op.depositId];
      return finishedAt === undefined || revision < finishedAt;
    }
    return until === null || revision < until;
  });

/**
 * Settle op `id` at `revision`: it will go on the first read at or past `revision` — but FIRST, fold its
 * effect into the rows of every pending deposit op. Those rows exist nowhere but here (the daemon hasn't
 * planned them yet), so a status flip, a rename or a removal that touched them would silently undo itself
 * the moment the op went. Folding makes the edit permanent for as long as the rows themselves are.
 * `revision` 0 (the default) means "nothing daemon-side to wait for" — an edit that only ever touched
 * optimistic rows — so the op goes on the next prune, its folded effect intact.
 */
export const settle = (ops: readonly PendingOp[], id: number, revision = 0): PendingOp[] => {
  const settling = ops.find((o) => o.id === id);
  if (!settling) return [...ops];
  return ops.map((o) => {
    if (o.id === id) return { ...o, until: revision };
    if (o.op.kind !== "deposit" || settling.op.kind === "deposit") return o;
    return { ...o, op: { ...o.op, rows: applyOp({ files: o.op.rows, folders: [] }, settling.op).files } };
  });
};

/** Drop op `id` — a rejected command; the tree snaps back to what the daemon has. */
export const rollback = (ops: readonly PendingOp[], id: number): PendingOp[] => ops.filter((o) => o.id !== id);

/**
 * The daemon accepted a deposit for these rows: stamp `depositId` on them so their op settles on THAT run's
 * end. Rows are moved into their own op when the ids are a subset (a retry of some of a rejected drop's
 * rows): the rest stay behind, un-accepted, exactly as they were.
 */
export const acceptDeposit = (ops: readonly PendingOp[], ids: readonly string[], depositId: string, nextId: () => number): PendingOp[] => {
  const set = new Set(ids);
  return ops.flatMap((o) => {
    if (o.op.kind !== "deposit") return [o];
    const mine = o.op.rows.filter((r) => set.has(r.id));
    if (mine.length === 0) return [o];
    const rest = o.op.rows.filter((r) => !set.has(r.id));
    const accepted: PendingOp = { id: rest.length === 0 ? o.id : nextId(), op: { kind: "deposit", rows: mine, depositId }, until: null };
    return rest.length === 0 ? [accepted] : [{ ...o, op: { ...o.op, rows: rest } }, accepted];
  });
};
