/**
 * The optimistic-edit overlay (`overlay.ts`) — the regressions of 2026-09-03, as tests:
 *   - a stale `listFiles` landing after a move must NOT put the folder back (the edit is re-applied);
 *   - a re-read mid-drop must NOT wipe the "uploading" rows (they hold until their run's end);
 *   - an edit lets go exactly at the read that reflects it, and a refused one snaps back.
 */
import { describe, expect, test } from "bun:test";
import type { ArchivedFile } from "./model.ts";
import { type PendingOp, acceptDeposit, applyOps, prune, rollback, settle } from "./overlay.ts";

const file = (id: string, relativePath: string, extra: Partial<ArchivedFile> = {}): ArchivedFile => ({
  id,
  relativePath,
  size: 1,
  status: "frozen",
  kind: "other",
  date: null,
  modifiedAt: null,
  createdAt: null,
  lastAttemptAt: null,
  error: null,
  failureKind: null,
  depositId: null,
  sourcePath: null,
  ...extra,
});

const paths = (files: readonly ArchivedFile[]): string[] => files.map((f) => f.relativePath).sort();

let seq = 0;
const op = (o: PendingOp["op"], until: number | null = null): PendingOp => ({ id: ++seq, op: o, until });

describe("a move holds over a stale read, and lets go at the read that reflects it", () => {
  const before = { files: [file("a", "Old/a.jpg"), file("b", "Old/sub/b.jpg")], folders: ["Old/empty"] };
  const move = op({ kind: "move", targets: [{ kind: "folder", path: "Old" }], toDir: "Archive" });

  test("the optimistic edit re-parents the whole subtree, empty folders included", () => {
    const t = applyOps(before, [move]);
    expect(paths(t.files)).toEqual(["Archive/Old/a.jpg", "Archive/Old/sub/b.jpg"]);
    expect(t.folders).toEqual(["Archive/Old/empty"]);
  });

  test("a read from BEFORE the move (older revision) still shows it moved — the op is re-applied", () => {
    const settled = settle([move], move.id, 7); // the ack said: reflected at revision 7
    const held = prune(settled, 6, {}); // a read at revision 6 landed late
    expect(held).toHaveLength(1);
    expect(paths(applyOps(before, held).files)).toEqual(["Archive/Old/a.jpg", "Archive/Old/sub/b.jpg"]);
  });

  test("the read at the ack's revision is the first that may drop it", () => {
    const settled = settle([move], move.id, 7);
    expect(prune(settled, 7, {})).toHaveLength(0);
    expect(prune(settled, 8, {})).toHaveLength(0);
  });

  test("re-applying over a tree that already reflects the move is a no-op", () => {
    const after = { files: [file("a", "Archive/Old/a.jpg")], folders: [] };
    expect(paths(applyOps(after, [move]).files)).toEqual(["Archive/Old/a.jpg"]);
  });

  test("a refused move rolls back — the tree is the daemon's again", () => {
    expect(applyOps(before, rollback([move], move.id))).toEqual(before);
  });
});

describe("a drop's rows survive every re-read until their run has finished", () => {
  const dropped = [file("dep-1-0", "Videos/a.mp4", { status: "uploading" }), file("dep-1-1", "Videos/b.mp4", { status: "uploading" })];
  const drop = op({ kind: "deposit", rows: dropped, depositId: null });

  test("a re-read triggered by something else (a folder created) keeps them", () => {
    const readMidDrop = { files: [file("x", "Docs/x.pdf")], folders: ["new folder"] };
    const t = applyOps(readMidDrop, prune([drop], 12, {}));
    expect(paths(t.files)).toEqual(["Docs/x.pdf", "Videos/a.mp4", "Videos/b.mp4"]);
  });

  test("un-accepted rows never go, whatever the revision (the command was refused or is in flight)", () => {
    expect(prune([drop], 999, { "batch-1": 5 })).toHaveLength(1);
  });

  test("accepted rows go at the read past THEIR run's end, not any run's", () => {
    const accepted = acceptDeposit([drop], dropped.map((r) => r.id), "batch-1", () => ++seq);
    expect(accepted).toHaveLength(1);
    expect(prune(accepted, 20, { "batch-0": 20 })).toHaveLength(1); // some other run finished
    expect(prune(accepted, 20, { "batch-1": 21 })).toHaveLength(1); // ours finished, read not past it yet
    expect(prune(accepted, 21, { "batch-1": 21 })).toHaveLength(0);
  });

  test("a journal row at the same path is overridden by the optimistic one (a Replace is 'uploading' now)", () => {
    const read = { files: [file("j", "Videos/a.mp4", { status: "frozen" })], folders: [] };
    const t = applyOps(read, [drop]);
    expect(t.files.filter((f) => f.relativePath === "Videos/a.mp4")).toHaveLength(1);
    expect(t.files.find((f) => f.relativePath === "Videos/a.mp4")?.status).toBe("uploading");
  });

  test("a retry of SOME of a refused drop's rows splits them into their own accepted op", () => {
    const split = acceptDeposit([drop], ["dep-1-1"], "batch-2", () => ++seq);
    expect(split).toHaveLength(2);
    const [rest, accepted] = split;
    expect(rest?.op.kind === "deposit" && rest.op.rows.map((r) => r.id)).toEqual(["dep-1-0"]);
    expect(accepted?.op.kind === "deposit" && accepted.op.depositId).toBe("batch-2");
  });
});

describe("edits to optimistic rows fold into them when settled, so they outlive the edit's op", () => {
  const dropped = [file("dep-2-0", "a.jpg", { status: "uploading" })];
  const drop = op({ kind: "deposit", rows: dropped, depositId: null });

  test("a status flip (the deposit was refused → ⚠) stays after its own op is pruned", () => {
    const flip = op({ kind: "patch", byId: { "dep-2-0": { status: "failed", error: "nope", failureKind: "permanent" } } });
    const ops = prune(settle([drop, flip], flip.id), 1, {}); // settled with no revision → goes at once
    expect(ops).toHaveLength(1);
    const row = applyOps({ files: [], folders: [] }, ops).files[0];
    expect(row?.status).toBe("failed");
    expect(row?.error).toBe("nope");
  });

  test("removing an optimistic row is permanent — it doesn't come back when the remove op goes", () => {
    const remove = op({ kind: "remove", targets: [{ kind: "file", id: "dep-2-0", path: "a.jpg" }] });
    const ops = prune(settle([drop, remove], remove.id), 1, {});
    expect(applyOps({ files: [], folders: [] }, ops).files).toHaveLength(0);
  });

  test("a journal-row edit is NOT folded (there is nothing here to fold into); it holds until its revision", () => {
    const flip = op({ kind: "patch", byId: { j1: { status: "uploading" } } });
    const ops = settle([flip], flip.id, 4);
    expect(prune(ops, 3, {})).toHaveLength(1);
    expect(prune(ops, 4, {})).toHaveLength(0);
  });
});

describe("rename / delete / new folder", () => {
  const base = { files: [file("a", "Docs/a.pdf"), file("b", "Docs/inner/b.pdf")], folders: ["Docs/empty"] };

  test("renaming a folder sweeps its prefix over files and empty folders", () => {
    const t = applyOps(base, [op({ kind: "rename", target: { kind: "folder", path: "Docs" }, name: "Papers" })]);
    expect(paths(t.files)).toEqual(["Papers/a.pdf", "Papers/inner/b.pdf"]);
    expect(t.folders).toEqual(["Papers/empty"]);
  });

  test("renaming a file edits only its basename", () => {
    const t = applyOps(base, [op({ kind: "rename", target: { kind: "file", id: "a", path: "Docs/a.pdf" }, name: "z.pdf" })]);
    expect(paths(t.files)).toEqual(["Docs/inner/b.pdf", "Docs/z.pdf"]);
  });

  test("deleting a folder drops everything under it", () => {
    const t = applyOps(base, [op({ kind: "remove", targets: [{ kind: "folder", path: "Docs/inner" }, { kind: "file", id: "a", path: "Docs/a.pdf" }] })]);
    expect(t.files).toHaveLength(0);
    expect(t.folders).toEqual(["Docs/empty"]);
  });

  test("a new folder dedupes against the persisted marker once the daemon has it", () => {
    const create = op({ kind: "newFolder", path: "Docs/new" });
    expect(applyOps(base, [create]).folders).toEqual(["Docs/empty", "Docs/new"]);
    const persisted = { ...base, folders: ["Docs/empty", "Docs/new"] };
    expect(applyOps(persisted, [create]).folders).toEqual(["Docs/empty", "Docs/new"]);
  });

  test("a folder renamed while its create is still pending: both ops hold, in order", () => {
    const create = op({ kind: "newFolder", path: "untitled folder" });
    const rename = op({ kind: "rename", target: { kind: "folder", path: "untitled folder" }, name: "Taxes" });
    // The create's ack (rev 3) lands, its read (rev 3) too, while the rename (rev 4) is still in flight —
    // and a stale read at rev 2 from before either. Every combination must show "Taxes", never "untitled".
    const ops = settle([create, rename], create.id, 3);
    for (const rev of [2, 3]) {
      const held = prune(ops, rev, {});
      const persisted = rev >= 3 ? ["untitled folder"] : [];
      expect(applyOps({ files: [], folders: persisted }, held).folders).toEqual(["Taxes"]);
    }
  });
});
