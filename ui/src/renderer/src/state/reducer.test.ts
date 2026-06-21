/**
 * Headless test of the pure event-fold (no Electron, no DOM) — run with `bun test`. Exercises the
 * real reducer against real wire-shaped (string-valued) event payloads; nothing is mocked away.
 */
import { describe, expect, test } from "bun:test";
import { initialState, reducer, type AppState } from "./reducer.ts";

/** Apply a sequence of actions from the initial state. */
const run = (...actions: Parameters<typeof reducer>[1][]): AppState =>
  actions.reduce(reducer, initialState);

const status: AppState["status"] = {
  filesTotal: 10,
  filesArchived: 4,
  blobsVerified: 4,
  paused: false,
  running: false,
  permanentlyFailedBlobs: 0,
  sources: [{ id: "s1", kind: "folder", path: "/a" }],
};

describe("connection + snapshot", () => {
  test("connection state is recorded", () => {
    expect(run({ type: "connection", state: "connected" }).connection).toBe("connected");
  });

  test("statusLoaded sets the snapshot; sourcesLoaded patches sources onto it", () => {
    const s = run(
      { type: "statusLoaded", status },
      { type: "sourcesLoaded", sources: [{ id: "s2", kind: "folder", path: "/b" }] },
    );
    expect(s.status?.sources).toEqual([{ id: "s2", kind: "folder", path: "/b" }]);
  });

  test("sourcesLoaded is held (no-op) until a snapshot exists", () => {
    const s = run({ type: "sourcesLoaded", sources: [{ id: "s2", kind: "folder", path: "/b" }] });
    expect(s.status).toBeNull();
    expect(s).toBe(initialState); // unchanged reference → store skips the notify
  });
});

describe("run progress fold", () => {
  test("runStarted → fileArchived×2 → runFinished tallies and parses string counts", () => {
    const s = run(
      { type: "event", name: "runStarted", data: {} },
      { type: "event", name: "fileArchived", data: { file: "a.jpg", blob: "b1" } },
      { type: "event", name: "fileArchived", data: { file: "b.jpg", blob: "b2" } },
      { type: "event", name: "runFinished", data: { filesArchived: "2", filesTotal: "10", blobsFailed: "1" } },
    );
    expect(s.run).toMatchObject({ active: false, filesArchived: 2, filesTotal: 10, blobsFailed: 1 });
    // recent feed is most-recent-first and survives runFinished
    expect(s.run?.recent.map((r) => r.file)).toEqual(["b.jpg", "a.jpg"]);
  });

  test("fileArchived without a prior runStarted still folds (defensive)", () => {
    const s = run({ type: "event", name: "fileArchived", data: { file: "x", blob: "bx" } });
    expect(s.run?.filesArchived).toBe(1);
    expect(s.run?.active).toBe(true);
  });

  test("num() defaults non-numeric wire values to 0, never NaN", () => {
    const s = run({
      type: "event",
      name: "runFinished",
      data: { filesArchived: "", filesTotal: "nope", blobsFailed: "3" },
    });
    expect(s.run).toMatchObject({ filesArchived: 0, filesTotal: 0, blobsFailed: 3 });
  });
});

describe("failures, pause, restore, error", () => {
  test("blobFailed prepends with kind", () => {
    const s = run({
      type: "event",
      name: "blobFailed",
      data: { blob: "b9", kind: "permanent", message: "NoSuchBucket" },
    });
    expect(s.failures[0]).toEqual({ blob: "b9", kind: "permanent", message: "NoSuchBucket" });
  });

  test("paused/resumed flip the snapshot flag (no-op without a snapshot)", () => {
    expect(run({ type: "event", name: "paused", data: {} }).status).toBeNull();
    const s = run(
      { type: "statusLoaded", status },
      { type: "event", name: "paused", data: {} },
    );
    expect(s.status?.paused).toBe(true);
    expect(reducer(s, { type: "event", name: "resumed", data: {} }).status?.paused).toBe(false);
  });

  test("restore* events fold into one keyed activity, latest state winning", () => {
    const s = run(
      { type: "event", name: "restoreRequested", data: { file: "f1", tier: "Bulk" } },
      { type: "event", name: "restoreInProgress", data: { file: "f1" } },
      { type: "event", name: "restoreCompleted", data: { file: "f1", out: "/out/f1" } },
    );
    expect(s.restores.f1).toEqual({ file: "f1", state: "completed", tier: "Bulk", out: "/out/f1" });
  });

  test("error sets lastError", () => {
    expect(run({ type: "event", name: "error", data: { message: "boom" } }).lastError).toBe("boom");
  });

  test("sourcesChanged is a no-op in the reducer (controller refetches)", () => {
    const base = run({ type: "statusLoaded", status });
    expect(reducer(base, { type: "event", name: "sourcesChanged", data: { added: "/c" } })).toBe(base);
  });
});
