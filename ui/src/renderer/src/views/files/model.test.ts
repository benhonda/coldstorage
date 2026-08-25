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
  crumbsFor,
  ROOT_CRUMB,
  childrenOf,
  moveIsNoop,
  fileFromJournal,
  filesUnder,
  formatBytes,
  reparent,
  restoreBase,
  restoreOutPath,
  rewritePrefix,
  targetOf,
  totalBytes,
  type UploadProgress,
  uploadPercent,
  uniquifyPath,
  names,
  planDeposit,
  isUploadOutstanding,
  uploadStall,
  withName,
} from "./model.ts";

const file = (relativePath: string, size: number, status: ArchivedFile["status"] = "frozen"): ArchivedFile => ({
  id: relativePath,
  relativePath,
  size,
  status,
  kind: "other",
  date: null,
  lastAttemptAt: null,
  error: null,
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

  /** A folder's badges, from the statuses of the files under it. */
  const badgesOf = (...statuses: ArchivedFile["status"][]) => {
    const rows = childrenOf(statuses.map((st, i) => file(`a/f${i}`, 1, st)), "");
    const folder = rows[0];
    if (folder?.type !== "folder") throw new Error("expected a folder row");
    return folder.badges;
  };

  test("a stored folder with something happening inside says BOTH, primary first", () => {
    // The bug this replaces: one file thawing inside 40 stored photos painted the whole folder amber, so a
    // folder that was entirely backed up read as "this is all coming down" (Ben, 2026-08-24). The folder is
    // still stored — that's the headline — and the thaw rides behind it, carrying how much of it is thawing.
    expect(badgesOf("frozen", "frozen", "pending")).toEqual({
      primary: "frozen",
      secondary: { status: "pending", count: 1, total: 3 },
    });
    expect(badgesOf("frozen", "uploading")).toEqual({
      primary: "frozen",
      secondary: { status: "uploading", count: 1, total: 2 },
    });
  });

  test("a folder with nothing settled yet has no second fact to tell", () => {
    // Everything under it is in flight, so there is no "what this folder is" distinct from what's happening
    // to it. One badge, exactly as before — a fresh drop must not sprout a ✓ for files that aren't stored.
    expect(badgesOf("uploading", "uploading")).toEqual({ primary: "uploading", secondary: null });
  });

  test("needs-you stays the PRIMARY — it isn't 'activity', it's the folder not being what it claims", () => {
    // The one place the old precedence was right and must survive: a folder holding a stuck upload is not
    // stored, so demoting ⚠ behind a ✓ would be the same overstatement in the other direction.
    expect(badgesOf("frozen", "uploading", "stalled", "failed").primary).toBe("failed");
    expect(badgesOf("frozen", "uploading", "stalled").primary).toBe("stalled");
  });

  test("live work keeps its own order behind the badge — moving beats waiting", () => {
    // `transferring` is the more specific truth: something under here really is arriving. Pins the whole
    // chain, not one rung — a precedence nothing asserts is one that gets reordered by accident.
    expect(badgesOf("frozen", "uploading", "transferring").secondary?.status).toBe("uploading");
    expect(badgesOf("frozen", "transferring", "pending").secondary?.status).toBe("transferring");
    expect(badgesOf("frozen", "pending").secondary?.status).toBe("pending");
  });

  test("a half-downloaded folder is not 'saved on this Mac'", () => {
    // `here` needs EVERY file to be here — claiming a folder is on the Mac when half of it isn't is the
    // kind of overstatement that sends someone looking for files that aren't there.
    expect(badgesOf("here", "frozen")).toEqual({ primary: "frozen", secondary: null });
    expect(badgesOf("here", "here")).toEqual({ primary: "here", secondary: null });
  });

  test("one file still going up is enough to cost a folder its saved-here claim", () => {
    // Deliberately conservative, and the same rule as the half-downloaded case above: "saved on this Mac"
    // is a promise about EVERY file under here, so anything not yet settled downgrades it to plain Stored.
    // Erring the other way would send someone to a folder expecting a file that isn't in it.
    expect(badgesOf("here", "here", "uploading")).toEqual({
      primary: "frozen",
      secondary: { status: "uploading", count: 1, total: 3 },
    });
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
      lastAttemptAt: null,
      error: null,
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
        lastAttemptAt: null,
        error: null,
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

describe("restore destination paths (the folder-flattening fix)", () => {
  const folder = (path: string): RowTarget => ({ kind: "folder", path });
  const fileT = (path: string): RowTarget => ({ kind: "file", id: path, path });
  const out = (vaultPath: string, targets: RowTarget[]): string =>
    restoreOutPath(vaultPath, restoreBase(targets), "/Users/ben/Downloads");

  test("requesting a folder brings the folder back, not its files in a heap", () => {
    // The 2026-07-27 bug: every file landed as Downloads/<basename>, so this whole tree collapsed into
    // one directory and `2019/beach.jpg` and `2020/beach.jpg` overwrote each other.
    const t = [folder("Photos")];
    expect(out("Photos/2019/beach.jpg", t)).toBe("/Users/ben/Downloads/Photos/2019/beach.jpg");
    expect(out("Photos/2020/beach.jpg", t)).toBe("/Users/ben/Downloads/Photos/2020/beach.jpg");
  });

  test("requesting a nested folder brings back that folder, not its ancestors", () => {
    expect(out("Photos/2019/beach.jpg", [folder("Photos/2019")])).toBe("/Users/ben/Downloads/2019/beach.jpg");
  });

  test("requesting files still saves them flat, exactly as before", () => {
    const t = [fileT("Photos/beach.jpg"), fileT("Photos/sunset.jpg")];
    expect(out("Photos/beach.jpg", t)).toBe("/Users/ben/Downloads/beach.jpg");
    expect(out("Photos/sunset.jpg", t)).toBe("/Users/ben/Downloads/sunset.jpg");
  });

  test("a root-level file saves flat", () => {
    expect(out("readme.txt", [fileT("readme.txt")])).toBe("/Users/ben/Downloads/readme.txt");
  });

  test("targets under different parents each keep their own path, so they cannot collide", () => {
    const t = [folder("Photos/2019"), folder("Photos/2020")];
    expect(out("Photos/2019/beach.jpg", t)).toBe("/Users/ben/Downloads/2019/beach.jpg");
    expect(out("Photos/2020/beach.jpg", t)).toBe("/Users/ben/Downloads/2020/beach.jpg");
  });

  test("a sibling sharing a name prefix is not treated as an ancestor", () => {
    expect(restoreBase([folder("Photos"), folder("Photos-old")])).toBe("");
  });

  test("a file outside the base falls back to its name rather than a negative slice", () => {
    expect(restoreOutPath("Docs/tax.pdf", "Photos", "/tmp")).toBe("/tmp/tax.pdf");
  });
});

/**
 * The upload half of the honesty pair (2026-08-21). A journal `planned` file renders as "Uploading", and
 * until the daemon recorded transient faults and stamped `lastAttemptAt` that arrow had no expiry and no
 * reason — a file whose blob had been failing all week looked exactly like one queued a second ago.
 */
describe("uploadStall", () => {
  const DAY = 24 * 3600;
  const NOW = 1_700_000_000;
  const queued = (over: Partial<ArchivedFile> = {}): ArchivedFile => ({
    ...file("Photos/beach.jpg", 100, "uploading"),
    ...over,
  });

  test("a healthy queued file — recently attempted, no fault — is not stalled", () => {
    expect(uploadStall(queued({ lastAttemptAt: NOW - 60 }), NOW, DAY)).toBeNull();
  });

  test("a recorded fault reads as retrying, however recent the attempt", () => {
    // It IS being attended to — but the row must name the snag rather than show a healthy arrow.
    expect(uploadStall(queued({ lastAttemptAt: NOW - 5, error: "S3 RequestTimeout" }), NOW, DAY)).toBe("retrying");
  });

  test("silence past the daemon's own window reads as unattended", () => {
    expect(uploadStall(queued({ lastAttemptAt: NOW - 3 * DAY }), NOW, DAY)).toBe("unattended");
    // ...and the window is the daemon's, so a slow-beat daemon forgives the same gap.
    expect(uploadStall(queued({ lastAttemptAt: NOW - 3 * DAY }), NOW, 7 * DAY)).toBeNull();
  });

  test("a never-attempted file is QUEUED, not stalled — the deliberate asymmetry with restores", () => {
    // A `planned` row is created BY the run loop moments before it attempts the file, so null is the
    // ordinary state of a fresh deposit. Flagging it would light up every drop the instant it appeared.
    // (A restore row is the opposite: created by an explicit user request, so never-stepped IS a stall.)
    expect(uploadStall(queued({ lastAttemptAt: null }), NOW, DAY)).toBeNull();
  });

  test("only an upload can stall this way", () => {
    for (const status of ["frozen", "failed", "pending", "transferring", "here"] as const) {
      expect(uploadStall(queued({ status, lastAttemptAt: NOW - 90 * DAY }), NOW, DAY)).toBeNull();
    }
  });
});

/**
 * The deposit gate counts bytes that are queued but not yet in S3. Adding a `stalled` status quietly
 * dropped those files out of that count — a stalled upload is still coming, so under-counting is how the
 * vault sails past its quota (the exact failure App.tsx's `inFlightBytes` comment describes).
 */
describe("isUploadOutstanding", () => {
  test("a stalled upload still counts as bytes on their way", () => {
    expect(isUploadOutstanding("uploading")).toBe(true);
    expect(isUploadOutstanding("stalled")).toBe(true);
  });

  test("nothing else does — including a permanently failed upload", () => {
    // `failed` means the daemon STOPPED retrying, so those bytes are not coming and must not be reserved.
    for (const s of ["frozen", "failed", "pending", "transferring", "here"] as const) {
      expect(isUploadOutstanding(s)).toBe(false);
    }
  });
});

describe("names (what to call the things just dropped)", () => {
  test("names one and two dropped items outright", () => {
    expect(names(["Videos"])).toBe("\u201cVideos\u201d");
    expect(names(["a/Videos", "b/Photos"])).toBe("\u201cVideos\u201d and \u201cPhotos\u201d");
  });
  test("stops listing past two — a 40-file drop must not become a 40-name sentence", () => {
    expect(names(["a", "b", "c", "d"])).toBe("\u201ca\u201d, \u201cb\u201d and 2 more");
  });
  test("still says something when there is nothing to name", () => {
    expect(names([])).toBe("that");
  });
});

describe("crumbsFor", () => {
  test("root and shallow paths show every crumb", () => {
    expect(crumbsFor("")).toEqual({ shown: [ROOT_CRUMB], folded: [] });
    expect(crumbsFor("a/b")).toEqual({
      shown: [ROOT_CRUMB, { name: "a", path: "a" }, { name: "b", path: "a/b" }],
      folded: [],
    });
  });

  test("deeper than CRUMB_FOLD_ABOVE folds the middle: root › … › current", () => {
    expect(crumbsFor("a/b/c").folded).toEqual([]);
    expect(crumbsFor("a/b/c/d")).toEqual({
      shown: [ROOT_CRUMB, { name: "d", path: "a/b/c/d" }],
      folded: [
        { name: "a", path: "a" },
        { name: "b", path: "a/b" },
        { name: "c", path: "a/b/c" },
      ],
    });
  });
});
