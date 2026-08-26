import { describe, expect, test } from "bun:test";
import type { Deposit, Source } from "../../../../shared/ipc.ts";
import type { ArchivedFile } from "../files/model.ts";
import { batchName, buildUploads, groupFailures } from "./model.ts";

const file = (
  id: string,
  status: ArchivedFile["status"],
  extra: Partial<ArchivedFile> = {},
): ArchivedFile => ({
  id, relativePath: id, size: 1, status, kind: "other", date: null, lastAttemptAt: null,
  error: null, failureKind: null, depositId: null, sourcePath: "/src", ...extra,
});

const deposit = (id: string, extra: Partial<Deposit> = {}): Deposit => ({
  id, kind: "files", mode: "ingest", state: "done", dest: "", src: ["/Users/b/drop"], createdAt: 10, finishedAt: 20, ...extra,
});

const source = (mountPath: string, extra: Partial<Source> = {}): Source => ({
  id: `/${mountPath}`, kind: "folder", path: `/${mountPath}`, mountPath, paused: false, lastScanAt: null, error: null, ...extra,
});

describe("buildUploads", () => {
  test("a batch's counts come from the tree's rows, keyed by depositId — never stored", () => {
    const files = [
      file("drop/a.jpg", "frozen", { depositId: "d1" }),
      file("drop/b.jpg", "frozen", { depositId: "d1" }),
      file("drop/c.jpg", "failed", { depositId: "d1", failureKind: "permanent" }),
      file("drop/d.jpg", "failed", { depositId: "d1", failureKind: "interrupted", sourcePath: null }),
    ];
    const m = buildUploads([deposit("d1")], files, [], false);
    expect(m.batches).toHaveLength(1);
    const b = m.batches[0]!;
    expect(b.name).toBe("drop");
    expect(b.counts).toEqual({ stored: 2, inFlight: 0, failed: 2, retryable: 1 });
    expect(b.state).toBe("didntFinish");
    // Worst-for-the-user first, and every failed row lands in a group.
    expect(b.failures.map((g) => [g.kind, g.files.length])).toEqual([["interrupted", 1], ["permanent", 1]]);
    expect(m.failedTotal).toBe(2);
  });

  test("the headline state follows the deposit's own state, then the counts", () => {
    const owed = deposit("d1", { state: "pending", finishedAt: null });
    const queued = [file("x", "uploading", { depositId: "d1" })];
    expect(buildUploads([owed], queued, [], true).batches[0]!.state).toBe("uploading");
    expect(buildUploads([owed], queued, [], false).batches[0]!.state).toBe("waiting");
    expect(buildUploads([deposit("d1")], [file("x", "frozen", { depositId: "d1" })], [], false).batches[0]!.state).toBe("done");
  });

  test("a watched folder owns the unclaimed rows under its mount, and nothing else", () => {
    const files = [
      file("Camera/a.jpg", "frozen"),
      file("Camera/b.jpg", "failed", { failureKind: "permanent" }),
      file("CameraX/c.jpg", "failed", { failureKind: "permanent" }), // a sibling, not a child
      file("Camera/d.jpg", "failed", { failureKind: "permanent", depositId: "d1" }), // a drop's, even here
    ];
    const m = buildUploads([deposit("d1")], files, [source("Camera")], false);
    const f = m.folders[0]!;
    expect(f.name).toBe("Camera");
    expect(f.counts).toEqual({ stored: 1, inFlight: 0, failed: 1, retryable: 1 });
    expect(f.state).toBe("didntFinish");
    expect(m.batches[0]!.counts.failed).toBe(1);
    // The sibling's failure counts on the badge (the tree marks it) even though no row here owns it yet —
    // the daemon adopts it into a batch on its next pass, and the page catches up.
    expect(m.failedTotal).toBe(3);
  });

  test("a folder watched inside another owns its own files — the outer one never counts them twice", () => {
    const files = [
      file("Photos/a.jpg", "failed", { failureKind: "permanent" }),
      file("Photos/2024/b.jpg", "failed", { failureKind: "permanent" }),
      file("Photos/2024/c.jpg", "frozen"),
    ];
    const m = buildUploads([], files, [source("Photos"), source("Photos/2024")], false);
    const byName = Object.fromEntries(m.folders.map((f) => [f.name, f.counts]));
    expect(byName["Photos"]).toEqual({ stored: 0, inFlight: 0, failed: 1, retryable: 1 });
    expect(byName["Photos/2024"]).toEqual({ stored: 1, inFlight: 0, failed: 1, retryable: 1 });
    expect(m.folders.reduce((n, f) => n + f.counts.failed, 0)).toBe(m.failedTotal);
  });

  test("a source with no mount is not a row — the daemon never scans one, and it would claim everything", () => {
    const files = [file("Photos/a.jpg", "failed", { failureKind: "permanent" })];
    const m = buildUploads([], files, [source("", { id: "/legacy", path: "/legacy" }), source("Photos")], false);
    expect(m.folders.map((f) => f.name)).toEqual(["Photos"]);
  });

  test("a paused or unreachable folder says so before it says anything about counts", () => {
    expect(buildUploads([], [], [source("A", { paused: true })], false).folders[0]!.state).toBe("paused");
    expect(buildUploads([], [], [source("A", { error: "unmounted" })], false).folders[0]!.state).toBe("unreachable");
    expect(buildUploads([], [], [source("A")], false).folders[0]!.state).toBe("watching");
  });
});

describe("groupFailures", () => {
  test("a failed row with no kind still lands in a group rather than vanishing", () => {
    const groups = groupFailures([file("x", "failed", { failureKind: null })]);
    expect(groups.map((g) => g.kind)).toEqual(["permanent"]);
  });
});

describe("batchName", () => {
  test("names come from what was dropped, never raw paths", () => {
    expect(batchName({ kind: "files", src: ["/Users/b/Desktop/Tax 2025"] })).toBe("Tax 2025");
    expect(batchName({ kind: "files", src: ["/a/one.jpg", "/a/two.jpg"] })).toBe("one.jpg and two.jpg");
    expect(batchName({ kind: "files", src: ["/a/1", "/a/2", "/a/3", "/a/4"] })).toBe("1, 2 and 2 more");
    expect(batchName({ kind: "photos", src: ["id1", "id2"] })).toBe("2 photos");
    expect(batchName({ kind: "photos", src: ["id1"] })).toBe("1 photo");
    // An adopted-orphans batch names itself by vault folder the same way.
    expect(batchName({ kind: "files", src: ["bens-mbp-aug24-2026-adpharm-from-documents"] })).toBe("bens-mbp-aug24-2026-adpharm-from-documents");
  });
});
