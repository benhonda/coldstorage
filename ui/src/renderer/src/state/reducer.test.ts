/**
 * Headless test of the pure event-fold (no Electron, no DOM) — run with `bun test`. Exercises the
 * real reducer against real wire-shaped (string-valued) event payloads; nothing is mocked away.
 */
import { describe, expect, test } from "bun:test";
import { etaSeconds, foldSample, initialState, reducer, throughput, type AppState } from "./reducer.ts";
import type { RestoreRow } from "../../../shared/ipc.ts";

/** Apply a sequence of actions from the initial state. */
const run = (...actions: Parameters<typeof reducer>[1][]): AppState =>
  actions.reduce(reducer, initialState);

const status: AppState["status"] = {
  signedIn: true,
  filesTotal: 10,
  filesArchived: 4,
  blobsVerified: 4,
  running: false,
  uploadsPaused: false,
  permanentlyFailedBlobs: 0,
  sources: [{ id: "s1", kind: "folder", path: "/a", mountPath: "a", paused: false, lastScanAt: null, error: null }],
  bytesStored: 4096,
};

/** A wire-shaped transfer row (what `listRestores` hands back). */
const transfer = (id: string, state: RestoreRow["state"] = "pending"): RestoreRow => ({
  id,
  fileId: `f-${id}`,
  relativePath: `Photos/${id}.jpg`,
  out: `/Users/ben/Downloads/${id}.jpg`,
  state,
  tier: "bulk",
  jobId: "job-1",
  bytes: 1234,
  requestedAt: 1_700_000_000,
  readyAt: null,
  lastStepAt: null,
  completedAt: null,
  error: null,
  typicalWait: "~48 hours",
  typicalWaitSeconds: 48 * 60 * 60,
  freeUntil: null,
  resumable: false,
  staleAfterSeconds: 24 * 60 * 60,
});

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
      { type: "sourcesLoaded", sources: [{ id: "s2", kind: "folder", path: "/b", mountPath: "b", paused: false, lastScanAt: null, error: null }] },
    );
    expect(s.status?.sources).toEqual([{ id: "s2", kind: "folder", path: "/b", mountPath: "b", paused: false, lastScanAt: null, error: null }]);
  });

  test("sourcesLoaded is held (no-op) until a snapshot exists", () => {
    const s = run({ type: "sourcesLoaded", sources: [{ id: "s2", kind: "folder", path: "/b", mountPath: "b", paused: false, lastScanAt: null, error: null }] });
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
      files: [{ id: "f1", relativePath: "Taxes/2025.pdf", size: 4096, status: "archived", blobId: "b1", modifiedAt: null, createdAt: null }],
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

  test("fileArchived prunes the failure of its blob (a retry that lands clears the badge), leaving others", () => {
    const s = run(
      { type: "event", name: "blobFailed", data: { blob: "b1", kind: "overQuota", message: "full", paths: "a.jpg" } },
      { type: "event", name: "blobFailed", data: { blob: "b2", kind: "permanent", message: "NoSuchBucket", paths: "b.jpg" } },
      { type: "event", name: "fileArchived", data: { file: "f1", blob: "b1" } },
    );
    expect(s.failures.map((f) => f.blob)).toEqual(["b2"]);
  });


  test("restoresLoaded replaces the transfer list wholesale", () => {
    const s = run({ type: "restoresLoaded", restores: [transfer("t1"), transfer("t2")] });
    expect(s.restores.map((r) => r.id)).toEqual(["t1", "t2"]);

    // A later read is the whole truth, not a merge — the daemon's journal owns this list.
    const later = reducer(s, { type: "restoresLoaded", restores: [transfer("t2")] });
    expect(later.restores.map((r) => r.id)).toEqual(["t2"]);
  });

  test("depositsLoaded replaces the batch list wholesale, and sign-out clears it", () => {
    const batch = (id: string) => ({ id, kind: "files" as const, mode: "ingest" as const, state: "done" as const, dest: "", src: ["/d"], createdAt: 1, finishedAt: 2 });
    const s = run({ type: "depositsLoaded", deposits: [batch("d1"), batch("d2")] });
    expect(s.deposits.map((d) => d.id)).toEqual(["d1", "d2"]);
    expect(s.depositsLoad).toEqual({ state: "loaded" });
    // A failed re-read keeps the last good list and says so — stale beats blank, and blank must not read
    // as "nothing uploaded yet".
    const failed = reducer(s, { type: "depositsLoadFailed", error: "timed out" });
    expect(failed.deposits).toBe(s.deposits);
    expect(failed.depositsLoad).toEqual({ state: "failed", error: "timed out" });
    expect(reducer(s, { type: "depositsLoaded", deposits: [batch("d2")] }).deposits.map((d) => d.id)).toEqual(["d2"]);
    // The event says only "it changed" — no fold; the controller re-reads.
    expect(reducer(s, { type: "event", name: "depositsChanged", data: {} }).deposits).toBe(s.deposits);
  });

  test("restore events do NOT fold into the list — the controller re-reads it", () => {
    // Deliberate: folding these renderer-side is what used to lose an in-flight transfer. The events say
    // only "something moved"; `listRestores` says what.
    const loaded = run({ type: "restoresLoaded", restores: [transfer("t1", "pending")] });
    const after = reducer(loaded, { type: "event", name: "restoresChanged", data: {} });
    expect(after.restores).toEqual(loaded.restores);

    const done = reducer(loaded, {
      type: "event",
      name: "restoreCompleted",
      data: { file: "f-t1", out: "/out/f" },
    });
    expect(done.restores).toEqual(loaded.restores);
  });

  test("signing back in refills transfers that sign-out cleared", () => {
    // THE regression (2026-07-27, Ben): sign out and back in, and an in-flight transfer vanished — the
    // file just showed a green "Stored" ✓ again, with no sign a copy was on its way. Clearing on sign-out
    // is correct (it's another user's data until proven otherwise); what was missing is that the list is
    // refillable from the daemon, because the daemon is the one that actually owns it.
    const live = run(signedIn("a@b.com"), { type: "restoresLoaded", restores: [transfer("t1", "pending")] });
    expect(live.restores).toHaveLength(1);

    const out = reducer(live, signedOut);
    expect(out.restores).toEqual([]);

    const back = [signedIn("a@b.com"), { type: "restoresLoaded" as const, restores: [transfer("t1", "pending")] }].reduce(
      reducer,
      out,
    );
    expect(back.restores.map((r) => r.id)).toEqual(["t1"]);
    expect(back.restores[0]!.state).toBe("pending");
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

  test("uploadsPausedChanged folds into the status snapshot (and is held until one exists)", () => {
    const base = run({ type: "statusLoaded", status });
    const paused = reducer(base, { type: "event", name: "uploadsPausedChanged", data: { paused: "true" } });
    expect(paused.status?.uploadsPaused).toBe(true);
    const resumed = reducer(paused, { type: "event", name: "uploadsPausedChanged", data: { paused: "false" } });
    expect(resumed.status?.uploadsPaused).toBe(false);
    // No snapshot yet ⇒ nothing to fold; the first getStatus carries the same truth.
    expect(run({ type: "event", name: "uploadsPausedChanged", data: { paused: "true" } }).status).toBeNull();
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

  test("runFinished carries how many files a Stop left behind; absent means none", () => {
    const mid = run(progress({ bytesTotal: "1000", bytesUploaded: "640", filesTotal: "30" }));
    expect(mid.run?.filesStopped).toBeNull(); // unknown while active
    const stopped = reducer(mid, {
      type: "event", name: "runFinished",
      data: { filesArchived: "3", filesTotal: "30", blobsFailed: "0", filesStopped: "27" },
    });
    expect(stopped.run?.filesStopped).toBe(27);
    const early = reducer(mid, {
      type: "event", name: "runFinished",
      data: { filesArchived: "0", filesTotal: "0", blobsFailed: "0" },
    });
    expect(early.run?.filesStopped).toBe(0);
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

  test("the rate window starts at the first byte — prepare-stall ticks don't average into it", () => {
    const s = run(
      progress({ filesTotal: "6", bytesTotal: "2000000000", bytesUploaded: "0" }),
      progress({ filesTotal: "6", bytesTotal: "2000000000", bytesUploaded: "0", currentPath: "/a/big.wav" }),
    );
    expect(s.run?.samples).toEqual([]);
    const moved = reducer(s, progress({ filesTotal: "6", bytesTotal: "2000000000", bytesUploaded: "2048" }));
    expect(moved.run?.samples).toHaveLength(1); // the clock starts here, not at the drop
  });

  test("only ticks that MOVED bytes are samples — the '20 days ↔ 25 days' flicker on a 30 GB folder", () => {
    // Thousands of small files: the daemon ticks on every file start + archive, and bytes only move when a
    // 64 MiB part lands. Those zero-byte ticks used to fill the window and make the rate a coin flip.
    let w = foldSample([], 1000, 0);
    w = foldSample(w, 1000, 100); // file started — no bytes
    w = foldSample(w, 1000, 200); // file archived — no bytes
    w = foldSample(w, 2000, 300); // a part shipped
    expect(w).toEqual([{ t: 0, bytes: 1000 }, { t: 300, bytes: 2000 }]);
  });

  test("the window is TIME-bounded — old samples fall off, the newest of them stays as the anchor", () => {
    const MIN = 60_000;
    let w = foldSample([], 1, 0);
    w = foldSample(w, 2, 1 * MIN);
    w = foldSample(w, 3, 2 * MIN);
    w = foldSample(w, 4, 5 * MIN); // 0 and 1 min are outside a 2-minute window; 2 min is kept as anchor
    expect(w.map((x) => x.t)).toEqual([2 * MIN, 5 * MIN]);
    // Long gap: the previous sample is always kept, so the rate spans the whole gap (an honest slow rate,
    // not a null that would blank the ETA after every stall).
    w = foldSample(w, 5, 20 * MIN);
    expect(w.map((x) => x.t)).toEqual([5 * MIN, 20 * MIN]);
  });

  test("etaSeconds divides the remaining bytes by the smoothed rate", () => {
    const samples = [{ t: 0, bytes: 0 }, { t: 1000, bytes: 1_000_000 }]; // 1 MB/s
    expect(etaSeconds(samples, 1_000_000, 5_000_000)).toBe(4); // 4 MB left ÷ 1 MB/s
    expect(etaSeconds(samples, 5_000_000, 5_000_000)).toBeNull(); // already done
    expect(etaSeconds(samples, 0, null)).toBeNull(); // unknown total (photos)
  });

  test("no ETA from a sliver of the job — the '8 days left' banner on a 2 GB drop", () => {
    // What the user saw: 2 KB of a 2 GB deposit had landed, measured at ~3 KB/s. Extrapolated, that is
    // over eight days; the same upload actually finished in minutes. Say nothing until 1% is behind us.
    const crawl = [{ t: 0, bytes: 0 }, { t: 1000, bytes: 3000 }]; // 3 KB/s
    expect(etaSeconds(crawl, 2048, 2_000_000_000)).toBeNull();
    // Past the threshold the same rate IS the answer, however grim — that's a measurement, not a blip.
    expect(etaSeconds(crawl, 20_000_000, 2_000_000_000)).toBeCloseTo((2_000_000_000 - 20_000_000) / 3000);
  });
});

describe("download progress fold (the transferring row's bar)", () => {
  const tick = (id: string, bytes: string, totalBytes = "1234"): Parameters<typeof reducer>[1] => ({
    type: "event",
    name: "restoreProgress",
    data: { id, file: `f-${id}`, bytes, totalBytes },
  });

  test("ticks fold into an entry keyed by row id, with samples for rate/ETA", () => {
    const s = run(tick("t1", "100"), tick("t1", "400"));
    expect(s.restoreProgress["t1"]?.bytes).toBe(400);
    expect(s.restoreProgress["t1"]?.totalBytes).toBe(1234);
    expect(s.restoreProgress["t1"]?.samples.map((x) => x.bytes)).toEqual([100, 400]);
  });

  test("two transfers keep separate entries", () => {
    const s = run(tick("t1", "100"), tick("t2", "700"));
    expect(s.restoreProgress["t1"]?.bytes).toBe(100);
    expect(s.restoreProgress["t2"]?.bytes).toBe(700);
  });

  test("a 0 totalBytes is UNKNOWN, not a zero denominator", () => {
    // Nothing should ever divide by it — the bar goes indeterminate instead.
    expect(run(tick("t1", "100", "0")).restoreProgress["t1"]?.totalBytes).toBeNull();
  });

  test("restoresLoaded prunes entries whose row stopped transferring — no stale bars for the session", () => {
    const mid = run(tick("t1", "100"), tick("t2", "300"), {
      type: "restoresLoaded",
      restores: [transfer("t1", "transferring"), transfer("t2", "transferring")],
    });
    expect(Object.keys(mid.restoreProgress).sort()).toEqual(["t1", "t2"]);

    // t1 saves; t2 keeps going. t1's counter is done narrating and must go with it.
    const after = reducer(mid, {
      type: "restoresLoaded",
      restores: [transfer("t1", "saved"), transfer("t2", "transferring")],
    });
    expect(Object.keys(after.restoreProgress)).toEqual(["t2"]);
  });

  test("sign-out clears the slice with the rest of the vault-derived state", () => {
    const s = run(signedIn("a@b.com"), tick("t1", "100"));
    expect(reducer(s, signedOut).restoreProgress).toEqual({});
  });
});
