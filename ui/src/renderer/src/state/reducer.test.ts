/**
 * Headless test of the pure event-fold (no Electron, no DOM) — run with `bun test`. Exercises the
 * real reducer against real wire-shaped (string-valued) event payloads; nothing is mocked away.
 */
import { describe, expect, test } from "bun:test";
import { etaSeconds, initialState, reducer, throughput, type AppState } from "./reducer.ts";

/** Apply a sequence of actions from the initial state. */
const run = (...actions: Parameters<typeof reducer>[1][]): AppState =>
  actions.reduce(reducer, initialState);

const status: AppState["status"] = {
  signedIn: true,
  filesTotal: 10,
  filesArchived: 4,
  blobsVerified: 4,
  running: false,
  permanentlyFailedBlobs: 0,
  sources: [{ id: "s1", kind: "folder", path: "/a", mountPath: "a", paused: false }],
  bytesStored: 4096,
};

const signedIn = (email: string): Parameters<typeof reducer>[1] => ({
  type: "authChanged",
  auth: { configured: true, state: "signedIn", email, error: null, emailAvailable: true },
});
const signedOut: Parameters<typeof reducer>[1] = {
  type: "authChanged",
  auth: { configured: true, state: "signedOut", email: null, error: null, emailAvailable: true },
};

describe("connection + snapshot", () => {
  test("connection state is recorded", () => {
    expect(run({ type: "connection", state: "connected" }).connection).toBe("connected");
  });

  test("statusLoaded sets the snapshot; sourcesLoaded patches sources onto it", () => {
    const s = run(
      { type: "statusLoaded", status },
      { type: "sourcesLoaded", sources: [{ id: "s2", kind: "folder", path: "/b", mountPath: "b", paused: false }] },
    );
    expect(s.status?.sources).toEqual([{ id: "s2", kind: "folder", path: "/b", mountPath: "b", paused: false }]);
  });

  test("sourcesLoaded is held (no-op) until a snapshot exists", () => {
    const s = run({ type: "sourcesLoaded", sources: [{ id: "s2", kind: "folder", path: "/b", mountPath: "b", paused: false }] });
    expect(s.status).toBeNull();
    expect(s).toBe(initialState); // unchanged reference → store skips the notify
  });
});

/**
 * The renderer half of the 2026-07-13 cross-account leak. The daemon now serves nothing when signed out
 * (a signed-out `DaemonService` holds no `UserSession`), but the renderer keeps its OWN copy of the last
 * user's tree in memory, and `initialState` is only used at construction — so without a reset here,
 * account B would be shown account A's files for the window between signing in and the first refetch.
 */
describe("account switch clears vault-derived state", () => {
  const withVaultState = (...pre: Parameters<typeof reducer>[1][]): AppState =>
    run(...pre, { type: "statusLoaded", status }, {
      type: "filesLoaded",
      files: [{ id: "f1", relativePath: "Taxes/2025.pdf", size: 4096, status: "archived", blobId: "b1", date: null }],
    }, { type: "excludesLoaded", excludes: ["*.secret"] });

  test("signing out drops the previous account's files, sources and excludes", () => {
    const before = withVaultState(signedIn("alice@example.com"));
    expect(before.files).toHaveLength(1);

    const after = reducer(before, signedOut);
    expect(after.files).toEqual([]);
    expect(after.status).toBeNull();
    expect(after.excludes).toEqual([]);
  });

  test("switching straight from one account to another drops the first's files", () => {
    // The real shape of the bug: both ends are `signedIn`, so keying the reset on the auth STATE alone
    // would miss it. It must be keyed on the account.
    const alice = withVaultState(signedIn("alice@example.com"));
    const bob = reducer(alice, signedIn("bob@example.com"));

    expect(bob.files).toEqual([]);
    expect(bob.status).toBeNull();
    expect(bob.auth.email).toBe("bob@example.com");
  });

  test("a token refresh for the SAME account keeps the tree (no churn)", () => {
    const alice = withVaultState(signedIn("alice@example.com"));
    const refreshed = reducer(alice, signedIn("alice@example.com"));

    expect(refreshed.files).toHaveLength(1);
    expect(refreshed.status).not.toBeNull();
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

  test("uploadProgress folds per-file (id-keyed, parses bytes), latest wins", () => {
    const s = run(
      { type: "event", name: "runStarted", data: {} },
      { type: "event", name: "uploadProgress", data: { file: "big.mov", path: "v/big.mov", bytes: "64", totalBytes: "200" } },
      { type: "event", name: "uploadProgress", data: { file: "big.mov", path: "v/big.mov", bytes: "128", totalBytes: "200" } },
    );
    expect(s.run?.uploadProgress["big.mov"]).toEqual({ path: "v/big.mov", uploaded: 128, total: 200 });
  });

  test("fileArchived drops the file's live progress entry; runFinished clears all", () => {
    const mid = run(
      { type: "event", name: "runStarted", data: {} },
      { type: "event", name: "uploadProgress", data: { file: "big.mov", path: "v/big.mov", bytes: "128", totalBytes: "200" } },
    );
    const archived = reducer(mid, { type: "event", name: "fileArchived", data: { file: "big.mov", blob: "b1" } });
    expect(archived.run?.uploadProgress).toEqual({});
    const finished = reducer(mid, {
      type: "event",
      name: "runFinished",
      data: { filesArchived: "1", filesTotal: "1", blobsFailed: "0" },
    });
    expect(finished.run?.uploadProgress).toEqual({});
  });
});

describe("failures, pause, restore, error", () => {
  test("blobFailed prepends with kind + splits the newline-joined paths", () => {
    const s = run({
      type: "event",
      name: "blobFailed",
      data: { blob: "b9", kind: "permanent", message: "NoSuchBucket", paths: "Photos/a.jpg\nPhotos/b.jpg" },
    });
    expect(s.failures[0]).toEqual({
      blob: "b9",
      kind: "permanent",
      message: "NoSuchBucket",
      files: ["Photos/a.jpg", "Photos/b.jpg"],
    });
  });

  test("blobFailed with empty paths yields no file names (no empty-string entries)", () => {
    const s = run({
      type: "event",
      name: "blobFailed",
      data: { blob: "b9", kind: "transient", message: "timeout", paths: "" },
    });
    expect(s.failures[0]?.files).toEqual([]);
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

  test("error carries an actionable code (drives the toast recovery action)", () => {
    const s = run({ type: "event", name: "error", data: { message: "no access", code: "photosAccessDenied" } });
    expect(s.lastError).toBe("no access");
    expect(s.lastErrorCode).toBe("photosAccessDenied");
  });

  test("a code-less error clears any prior code (no stale recovery button)", () => {
    const withCode = run({ type: "event", name: "error", data: { message: "x", code: "photosAccessDenied" } });
    const cleared = reducer(withCode, { type: "event", name: "error", data: { message: "y" } });
    expect(cleared.lastErrorCode).toBeNull();
  });

  test("sourcesChanged is a no-op in the reducer (controller refetches)", () => {
    const base = run({ type: "statusLoaded", status });
    expect(reducer(base, { type: "event", name: "sourcesChanged", data: { added: "/c" } })).toBe(base);
  });
});

describe("run progress (the deposit bar / throughput / ETA)", () => {
  const progress = (d: Record<string, string>): Parameters<typeof reducer>[1] =>
    ({ type: "event", name: "runProgress", data: {
      filesTotal: "0", bytesTotal: "0", filesArchived: "0", bytesUploaded: "0", currentPath: "", ...d,
    } });

  test("the denominators are known from the first tick (not just at runFinished)", () => {
    const s = run(progress({ filesTotal: "100", bytesTotal: "2000000", bytesUploaded: "0" }));
    expect(s.run?.filesTotal).toBe(100);
    expect(s.run?.bytesTotal).toBe(2_000_000);
    expect(s.run?.active).toBe(true);
  });

  test("bytesTotal of 0 (a Photos deposit) is treated as UNKNOWN, not a real 0-byte total", () => {
    const s = run(progress({ filesTotal: "5", bytesTotal: "0", filesArchived: "2" }));
    expect(s.run?.bytesTotal).toBeNull(); // → UI shows count progress, not a 0-byte bar
    expect(s.run?.filesTotal).toBe(5);
  });

  test("currentPath carries the now-uploading file, and clears at runFinished", () => {
    const mid = run(progress({ currentPath: "Photos/IMG_1.jpg", bytesUploaded: "500" }));
    expect(mid.run?.currentPath).toBe("Photos/IMG_1.jpg");
    const done = reducer(mid, {
      type: "event", name: "runFinished",
      data: { filesArchived: "3", filesTotal: "3", blobsFailed: "0" },
    });
    expect(done.run?.currentPath).toBeNull();
    expect(done.run?.active).toBe(false);
  });

  test("runFinished snaps the bar to 100% (uploaded == the known total)", () => {
    const mid = run(progress({ bytesTotal: "1000", bytesUploaded: "640", filesTotal: "3" }));
    const done = reducer(mid, {
      type: "event", name: "runFinished",
      data: { filesArchived: "3", filesTotal: "3", blobsFailed: "0" },
    });
    expect(done.run?.bytesUploaded).toBe(1000);
    expect(done.run?.bytesTotal).toBe(1000);
  });

  test("throughput averages the sample window; needs ≥2 samples with forward progress", () => {
    expect(throughput([])).toBeNull();
    expect(throughput([{ t: 0, bytes: 100 }])).toBeNull();
    // 8 MB over 2 s = 4 MB/s.
    expect(throughput([{ t: 1000, bytes: 0 }, { t: 3000, bytes: 8_000_000 }])).toBe(4_000_000);
    // No forward progress → no rate (rather than 0, which reads as "stalled forever").
    expect(throughput([{ t: 1000, bytes: 5 }, { t: 2000, bytes: 5 }])).toBeNull();
  });

  test("etaSeconds divides the remaining bytes by the smoothed rate", () => {
    const samples = [{ t: 0, bytes: 0 }, { t: 1000, bytes: 1_000_000 }]; // 1 MB/s
    expect(etaSeconds(samples, 1_000_000, 5_000_000)).toBe(4); // 4 MB left ÷ 1 MB/s
    expect(etaSeconds(samples, 5_000_000, 5_000_000)).toBeNull(); // already done
    expect(etaSeconds(samples, 0, null)).toBeNull(); // unknown total (photos)
  });
});
