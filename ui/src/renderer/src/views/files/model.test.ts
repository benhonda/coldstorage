/**
 * Headless tests for the pure file-tree model (bun test, no React/daemon). Covers the derivation the
 * browser leans on: one directory's rows, folder rollups, virtual folders, and the path-rewrite ops
 * that make move/rename cheap journal edits.
 */
import { describe, expect, test } from "bun:test";
import type { ListedFile } from "../../../../shared/ipc.ts";
import {
  type ArchivedFile,
  type RowTarget,
  allFolderPaths,
  canMoveInto,
  childrenOf,
  moveIsNoop,
  fileFromJournal,
  filesUnder,
  formatBytes,
  reparent,
  rewritePrefix,
  targetOf,
  totalBytes,
  type UploadProgress,
  uploadPercent,
  uniquifyPath,
  planDeposit,
  withName,
} from "./model.ts";

const file = (relativePath: string, size: number, status: ArchivedFile["status"] = "frozen"): ArchivedFile => ({
  id: relativePath,
  relativePath,
  size,
  status,
  kind: "other",
  date: null,
});

const sample: ArchivedFile[] = [
  file("Photos/2019/beach.jpg", 100),
  file("Photos/2019/january/snow.jpg", 50),
  file("Photos/sunset.jpg", 25, "here"),
  file("readme.txt", 5),
];

describe("childrenOf", () => {
  test("root lists immediate folders then files, A–Z", () => {
    const rows = childrenOf(sample, "");
    expect(rows.map((r) => (r.type === "folder" ? `📁${r.name}` : r.name))).toEqual(["📁Photos", "readme.txt"]);
  });

  test("a folder row rolls up descendant size + count across nested dirs", () => {
    const photos = childrenOf(sample, "").find((r) => r.type === "folder" && r.name === "Photos");
    expect(photos).toMatchObject({ type: "folder", size: 175, count: 3 });
  });

  test("drilling in shows the level's folders and files", () => {
    const rows = childrenOf(sample, "Photos");
    expect(rows.map((r) => r.name)).toEqual(["2019", "sunset.jpg"]); // folder before file
  });

  test("status rollup settles on frozen unless something is actively happening", () => {
    const rows = childrenOf([file("a/x", 1, "frozen"), file("a/y", 1, "uploading")], "");
    const folder = rows[0];
    expect(folder.type === "folder" && folder.status).toBe("uploading");
  });

  test("a virtual (empty) folder surfaces only at its own level", () => {
    const rows = childrenOf(sample, "", ["Projects"]);
    const proj = rows.find((r) => r.type === "folder" && r.name === "Projects");
    expect(proj).toMatchObject({ empty: true, count: 0 });
    // not surfaced one level down where it doesn't belong
    expect(childrenOf(sample, "Photos", ["Projects"]).some((r) => r.name === "Projects")).toBe(false);
  });
});

describe("path ops", () => {
  test("withName replaces the basename only", () => {
    expect(withName("a/b/c.jpg", "d.jpg")).toBe("a/b/d.jpg");
  });

  test("reparent keeps the basename under a new dir", () => {
    expect(reparent("a/b/c.jpg", "x/y")).toBe("x/y/c.jpg");
    expect(reparent("a/b/c.jpg", "")).toBe("c.jpg");
  });

  test("rewritePrefix only touches descendants of the moved folder", () => {
    expect(rewritePrefix("a/b/c", "a/b", "x")).toBe("x/c");
    expect(rewritePrefix("a/b", "a/b", "x")).toBe("x");
    expect(rewritePrefix("a/bc", "a/b", "x")).toBe("a/bc"); // not a path-segment match
  });

  test("targetOf carries the FULL vault path (the daemon movePath/deletePath argument)", () => {
    // A nested file's target.path must be its whole relativePath, not just the basename — it's the `from`
    // sent to the daemon. (Folders already carry their full path.)
    expect(targetOf({ type: "file", name: "beach.jpg", file: file("Photos/2019/beach.jpg", 1) })).toEqual({
      kind: "file",
      id: "Photos/2019/beach.jpg",
      path: "Photos/2019/beach.jpg",
    });
  });
});

describe("aggregates", () => {
  test("filesUnder is inclusive of the whole subtree; root = all", () => {
    expect(filesUnder(sample, "Photos")).toHaveLength(3);
    expect(filesUnder(sample, "")).toHaveLength(4);
  });

  test("totalBytes sums sizes", () => {
    expect(totalBytes(sample)).toBe(180);
  });

  test("allFolderPaths enumerates every implied + virtual folder", () => {
    expect(allFolderPaths(sample, ["Projects"])).toEqual(["Photos", "Photos/2019", "Photos/2019/january", "Projects"]);
  });

  test("formatBytes is decimal and trims a trailing .0", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(4_100_000)).toBe("4.1 MB");
    expect(formatBytes(2_000_000_000)).toBe("2 GB");
    expect(formatBytes(512)).toBe("512 B");
  });

  describe("fileFromJournal", () => {
    const row = (over: Partial<ListedFile> = {}): ListedFile => ({
      id: "f1",
      relativePath: "Photos/2019/beach.jpg",
      size: 4_100_000,
      status: "archived",
      blobId: "blob-1",
      date: null,
      ...over,
    });

    test("maps an archived row to a frozen photo, kind from name, null date when absent", () => {
      const f = fileFromJournal(row());
      expect(f).toEqual({
        id: "f1",
        relativePath: "Photos/2019/beach.jpg",
        size: 4_100_000,
        status: "frozen",
        kind: "photo",
        date: null,
      });
    });

    test("renders the journal's epoch-seconds date to an ISO string", () => {
      // 1_700_000_000 s → 2023-11-14T22:13:20.000Z (epoch is seconds; JS Date wants ms).
      expect(fileFromJournal(row({ date: 1_700_000_000 })).date).toBe("2023-11-14T22:13:20.000Z");
    });

    test("coarsens in-pipeline statuses to uploading", () => {
      for (const s of ["planned", "uploading", "verifying", "discovered"]) {
        expect(fileFromJournal(row({ status: s })).status).toBe("uploading");
      }
    });

    test("failed → failed (needs attention), never silently frozen", () => {
      expect(fileFromJournal(row({ status: "failed" })).status).toBe("failed");
    });

    test("unknown status defaults to uploading, never silently frozen", () => {
      expect(fileFromJournal(row({ status: "bogus" })).status).toBe("uploading");
    });
  });
});

describe("uploadPercent", () => {
  const prog = (over: Record<string, UploadProgress> = {}): Record<string, UploadProgress> => over;

  test("matches by journal id and rounds the percent", () => {
    const p = prog({ "v/big.mov": { path: "v/big.mov", uploaded: 64, total: 200 } });
    expect(uploadPercent(p, { id: "v/big.mov", relativePath: "v/big.mov" })).toBe(32);
  });

  test("falls back to matching by path (optimistic drop row's synthetic id)", () => {
    // daemon keyed the entry by the real path; the row still has its synthetic `dep-…` id.
    const p = prog({ "v/big.mov": { path: "v/big.mov", uploaded: 100, total: 200 } });
    expect(uploadPercent(p, { id: "dep-1-0", relativePath: "v/big.mov" })).toBe(50);
  });

  test("no entry → null (indeterminate bar)", () => {
    expect(uploadPercent(prog(), { id: "x", relativePath: "x" })).toBeNull();
  });

  test("zero/unknown total → null, never a divide-by-zero", () => {
    const p = prog({ x: { path: "x", uploaded: 0, total: 0 } });
    expect(uploadPercent(p, { id: "x", relativePath: "x" })).toBeNull();
  });

  test("clamps to 100 even if bytes overshoot the total", () => {
    const p = prog({ x: { path: "x", uploaded: 250, total: 200 } });
    expect(uploadPercent(p, { id: "x", relativePath: "x" })).toBe(100);
  });
});

describe("uniquifyPath (Keep Both naming)", () => {
  test("first free ' N' suffix, extension + dir preserved", () => {
    expect(uniquifyPath("Photos/IMG_8114.HEIC", new Set(["Photos/IMG_8114.HEIC"]))).toBe("Photos/IMG_8114 2.HEIC");
    expect(uniquifyPath("Photos/IMG_8114.HEIC", new Set(["Photos/IMG_8114.HEIC", "Photos/IMG_8114 2.HEIC"]))).toBe(
      "Photos/IMG_8114 3.HEIC",
    );
  });
  test("no extension / root / leading-dot leaf", () => {
    expect(uniquifyPath("README", new Set(["README"]))).toBe("README 2");
    expect(uniquifyPath("notes.txt", new Set(["notes.txt"]))).toBe("notes 2.txt");
    expect(uniquifyPath("a/.gitignore", new Set(["a/.gitignore"]))).toBe("a/.gitignore 2"); // leading dot = no ext
  });
});

describe("planDeposit (collision resolution)", () => {
  const tree = new Set(["F/a.jpg"]); // one existing file in folder F

  test("no collisions → every item lands, no conflicts map", () => {
    const { rows, conflicts } = planDeposit(
      [{ relativePath: "F/new.jpg", exists: false }],
      {},
      tree,
    );
    expect(rows.map((r) => r.relativePath)).toEqual(["F/new.jpg"]);
    expect(conflicts).toEqual({});
  });

  test("skip drops the item; replace keeps the path; both recorded for the daemon", () => {
    const skip = planDeposit([{ relativePath: "F/a.jpg", exists: true }], { "F/a.jpg": "skip" }, tree);
    expect(skip.rows).toEqual([]);
    expect(skip.conflicts).toEqual({ "F/a.jpg": "skip" });

    const replace = planDeposit([{ relativePath: "F/a.jpg", exists: true }], { "F/a.jpg": "replace" }, tree);
    expect(replace.rows.map((r) => r.relativePath)).toEqual(["F/a.jpg"]);
    expect(replace.conflicts).toEqual({ "F/a.jpg": "replace" });
  });

  test("keepBoth renames optimistically, dodging the existing row AND a same-drop sibling", () => {
    const { rows, conflicts } = planDeposit(
      [
        { relativePath: "F/a.jpg", exists: true }, // keepBoth → must avoid F/a.jpg and the new F/a 2.jpg
        { relativePath: "F/a 2.jpg", exists: false }, // a brand-new sibling that keeps its name
      ],
      { "F/a.jpg": "keepBoth" },
      tree,
    );
    expect(rows.map((r) => r.relativePath).sort()).toEqual(["F/a 2.jpg", "F/a 3.jpg"]);
    expect(rows.find((r) => r.original === "F/a.jpg")?.relativePath).toBe("F/a 3.jpg");
    expect(conflicts).toEqual({ "F/a.jpg": "keepBoth" });
  });
});

describe("move legality (drag-to-move + Move to…)", () => {
  const folder = (path: string): RowTarget => ({ kind: "folder", path });
  const fileT = (path: string): RowTarget => ({ kind: "file", id: path, path });

  test("a folder can't move into itself or its own subtree", () => {
    expect(canMoveInto([folder("Photos")], "Photos")).toBe(false);
    expect(canMoveInto([folder("Photos")], "Photos/2019")).toBe(false);
    expect(canMoveInto([folder("Photos")], "Backups")).toBe(true);
    // a sibling that merely shares the name prefix is NOT the subtree
    expect(canMoveInto([folder("Photos")], "Photos-old")).toBe(true);
  });

  test("one illegal folder blocks the whole multi-item drag", () => {
    expect(canMoveInto([fileT("readme.txt"), folder("Photos")], "Photos/2019")).toBe(false);
  });

  test("files can move anywhere, including up to the root", () => {
    expect(canMoveInto([fileT("Photos/2019/beach.jpg")], "")).toBe(true);
  });

  test("moveIsNoop flags a drop into the dir every target already lives in", () => {
    expect(moveIsNoop([fileT("Photos/beach.jpg"), folder("Photos/2019")], "Photos")).toBe(true);
    expect(moveIsNoop([fileT("Photos/beach.jpg")], "")).toBe(false); // root is a REAL move up
    expect(moveIsNoop([fileT("readme.txt")], "")).toBe(true); // a root item dropped on the root crumb
    expect(moveIsNoop([fileT("Photos/beach.jpg"), fileT("readme.txt")], "Photos")).toBe(false); // mixed parents → a real move
  });
});
