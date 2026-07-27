/**
 * The request-grouping fold — what becomes ONE row on the Downloads page, what it's called, which state
 * headlines a request whose files disagree, and what its bar/countdown may honestly claim. All pure
 * functions over the daemon's per-file `listRestores` rows; the wire stays per-file and untested here.
 */
import { describe, expect, test } from "bun:test";
import type { RestoreRow } from "../../../../shared/ipc.ts";
import {
  aggregateState,
  commonOutDir,
  groupDownloads,
  groupFraction,
  latestPendingRow,
} from "./model.ts";

const HOUR = 3600;
const ASKED = 1_700_000_000;

let seq = 0;
const row = (over: Partial<RestoreRow> = {}): RestoreRow => ({
  id: `t${++seq}`,
  fileId: `f${seq}`,
  relativePath: `Photos/pic-${seq}.jpg`,
  out: `/Users/ben/Downloads/Photos/pic-${seq}.jpg`,
  state: "pending",
  tier: "bulk",
  jobId: "job-1",
  bytes: 100,
  requestedAt: ASKED,
  readyAt: null,
  completedAt: null,
  error: null,
  typicalWait: "~48 hours",
  typicalWaitSeconds: 48 * HOUR,
  freeUntil: null,
  resumable: false,
  ...over,
});

describe("groupDownloads", () => {
  test("rows sharing a jobId fold into one request; different jobs stay apart", () => {
    const groups = groupDownloads([
      row({ jobId: "job-a" }),
      row({ jobId: "job-a" }),
      row({ jobId: "job-b" }),
    ]);
    expect(groups.map((g) => g.rows.length)).toEqual([2, 1]);
  });

  test("keeps the daemon's newest-first order by each request's first appearance", () => {
    const groups = groupDownloads([
      row({ jobId: "newer" }),
      row({ jobId: "older" }),
      row({ jobId: "newer" }),
    ]);
    expect(groups.map((g) => g.key)).toEqual(["newer", "older"]);
  });

  test("rows with no jobId (dogfood mode) are never merged with each other", () => {
    // Two unrelated dogfood requests sharing a "null" group would show one row for two asks.
    const groups = groupDownloads([row({ jobId: null }), row({ jobId: null })]);
    expect(groups).toHaveLength(2);
  });

  test("a folder request is named after the folder its files share", () => {
    const g = groupDownloads([
      row({ relativePath: "Photos/beach.jpg" }),
      row({ relativePath: "Photos/2019/hike.jpg" }),
    ])[0]!;
    expect(g.label).toBe("Photos");
  });

  test("a nested folder request is named after the deepest shared folder, not the whole path", () => {
    const g = groupDownloads([
      row({ relativePath: "Backups/Photos/a.jpg" }),
      row({ relativePath: "Backups/Photos/b.jpg" }),
    ])[0]!;
    expect(g.label).toBe("Photos");
  });

  test("a mixed multi-select that shares no folder has NO label — the view shows the count instead", () => {
    // Null rather than a "2 files" string, so the view can also skip the count in the meta line and
    // never render "2 files" twice in one row.
    const g = groupDownloads([
      row({ relativePath: "a.jpg" }),
      row({ relativePath: "b.jpg" }),
    ])[0]!;
    expect(g.label).toBeNull();
  });

  test("a single-file request is just the file, even though it lives in a folder", () => {
    const g = groupDownloads([row({ relativePath: "Photos/beach.jpg" })])[0]!;
    expect(g.label).toBe("beach.jpg");
  });

  test("sums bytes, counts done/failed, and takes the earliest ask as the request's", () => {
    const g = groupDownloads([
      row({ bytes: 10, state: "saved", requestedAt: ASKED + 5, completedAt: ASKED + 100 }),
      row({ bytes: 20, state: "failed", requestedAt: ASKED }),
      row({ bytes: 30, state: "pending", requestedAt: ASKED + 9 }),
    ])[0]!;
    expect(g.bytes).toBe(60);
    expect(g.doneCount).toBe(1);
    expect(g.failedCount).toBe(1);
    expect(g.requestedAt).toBe(ASKED);
  });

  test("completedAt exists only once EVERY file has landed — a half-saved request has no finish time", () => {
    const partial = groupDownloads([
      row({ state: "saved", completedAt: ASKED + 50 }),
      row({ state: "pending" }),
    ])[0]!;
    expect(partial.completedAt).toBeNull();

    const done = groupDownloads([
      row({ state: "saved", completedAt: ASKED + 50 }),
      row({ state: "saved", completedAt: ASKED + 80 }),
    ])[0]!;
    expect(done.completedAt).toBe(ASKED + 80);
  });
});

describe("aggregateState", () => {
  test("an unpaid part headlines over everything — nothing moves until it's paid", () => {
    expect(aggregateState([row({ state: "transferring" }), row({ state: "needsAuthorization" })])).toBe(
      "needsAuthorization",
    );
  });

  test("live movement outranks waiting", () => {
    expect(aggregateState([row({ state: "pending" }), row({ state: "transferring" })])).toBe("transferring");
  });

  test("while anything is active, terminal states stay out of the headline", () => {
    expect(aggregateState([row({ state: "failed" }), row({ state: "pending" })])).toBe("pending");
  });

  test("once nothing is active, bad news outranks tidy endings — a failed file must not read Done", () => {
    expect(aggregateState([row({ state: "saved" }), row({ state: "failed" })])).toBe("failed");
    expect(aggregateState([row({ state: "saved" }), row({ state: "canceled" })])).toBe("canceled");
    expect(aggregateState([row({ state: "saved" }), row({ state: "saved" })])).toBe("saved");
  });
});

describe("latestPendingRow", () => {
  test("the countdown speaks for the SLOWEST pending file — the request is done thawing when it is", () => {
    const slow = row({ state: "pending", requestedAt: ASKED, typicalWaitSeconds: 48 * HOUR });
    const fast = row({ state: "pending", requestedAt: ASKED, typicalWaitSeconds: 12 * HOUR });
    expect(latestPendingRow([fast, slow, row({ state: "saved" })])).toBe(slow);
  });

  test("no pending files → no countdown to fake", () => {
    expect(latestPendingRow([row({ state: "transferring" }), row({ state: "saved" })])).toBeUndefined();
  });
});

describe("groupFraction", () => {
  test("saved bytes plus mid-flight bytes over the request's total, capped at 1", () => {
    const a = row({ state: "saved", bytes: 50 });
    const b = row({ state: "transferring", bytes: 50 });
    const g = groupDownloads([a, b])[0]!;
    expect(groupFraction(g, { [b.id]: { bytes: 25, totalBytes: 50, samples: [] } })).toBe(0.75);
  });

  test("nothing landed yet → null, so the bar shimmers instead of claiming zero forever", () => {
    const b = row({ state: "transferring", bytes: 50 });
    const g = groupDownloads([row({ state: "pending", bytes: 50 }), b])[0]!;
    expect(groupFraction(g, {})).toBeNull();
  });

  test("an unknown total (all rows 0 bytes) can't yield an honest fraction", () => {
    const g = groupDownloads([row({ bytes: 0 }), row({ bytes: 0 })])[0]!;
    expect(groupFraction(g, {})).toBeNull();
  });
});

describe("commonOutDir", () => {
  test("a folder request reveals the folder it saved as", () => {
    const dir = commonOutDir([
      row({ out: "/Users/ben/Desktop/Photos/beach.jpg" }),
      row({ out: "/Users/ben/Desktop/Photos/2019/hike.jpg" }),
    ]);
    expect(dir).toBe("/Users/ben/Desktop/Photos");
  });

  test("a flat multi-select reveals the chosen destination itself", () => {
    const dir = commonOutDir([
      row({ out: "/Users/ben/Desktop/a.jpg" }),
      row({ out: "/Users/ben/Desktop/b.jpg" }),
    ]);
    expect(dir).toBe("/Users/ben/Desktop");
  });
});
