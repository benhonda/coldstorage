/**
 * Headless tests for the pure file-tree model (bun test, no React/daemon). Covers the derivation the
 * browser leans on: one directory's rows, folder rollups, virtual folders, and the path-rewrite ops
 * that make move/rename cheap journal edits.
 */
import { describe, expect, test } from "bun:test";
import type { ListedFile } from "../../../../shared/ipc.ts";
import {
  type ArchivedFile,
  allFolderPaths,
  childrenOf,
  fileFromJournal,
  filesUnder,
  formatBytes,
  reparent,
  rewritePrefix,
  totalBytes,
  type UploadProgress,
  uploadPercent,
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
      ...over,
    });

    test("maps an archived row to a frozen photo, kind from name, no date", () => {
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

    test("coarsens in-pipeline statuses to uploading", () => {
      for (const s of ["planned", "staging", "uploading", "verifying", "discovered"]) {
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
