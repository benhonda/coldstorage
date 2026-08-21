/**
 * The Downloads countdown + the downloading row's live bar — which row gets a clock, what the readout
 * says as the signal firms up, and what the estimate's overrun reads like. The PHRASING of durations is
 * `ui/duration.ts`'s and tested there; this covers only the decisions this page makes. (The request
 * GROUPING — one row per ask — is `downloads/model.ts`'s and tested there.)
 */
import { describe, expect, test } from "bun:test";
import type { RestoreRow } from "../../../shared/ipc.ts";
import type { RestoreProgress } from "../state/reducer.ts";
import { restoreStall } from "../../../shared/ipc.ts";
import { progressFraction, progressLine, remaining } from "./DownloadsView.tsx";

const HOUR = 3600;
const REQUESTED = 1_700_000_000;
/** The daemon's silence window, as `Status.staleAfterSeconds` reports it at the default 300s beat. */
const STALE_AFTER = 24 * HOUR;

const row = (over: Partial<RestoreRow> = {}): RestoreRow => ({
  id: "t1",
  fileId: "f1",
  relativePath: "Photos/beach.jpg",
  out: "/Users/ben/Downloads/beach.jpg",
  state: "pending",
  tier: "bulk",
  jobId: "job-1",
  bytes: 2048,
  requestedAt: REQUESTED,
  readyAt: null,
  lastStepAt: null,
  completedAt: null,
  error: null,
  typicalWait: "~48 hours",
  typicalWaitSeconds: 48 * HOUR,
  freeUntil: null,
  resumable: false,
  ...over,
});

/** A row the run loop is actively stepping, as at `now` — the normal case, and the one every countdown
 * assertion depends on. Spelled out per test rather than defaulted into the fixture, because "when did we
 * last check?" is the variable under test here, not scenery. */
const watchedAt = (now: number, over: Partial<RestoreRow> = {}): RestoreRow =>
  row({ lastStepAt: now - 60, ...over });

describe("remaining", () => {
  test("counts down from the tier's own estimate", () => {
    const now = REQUESTED + 7 * HOUR;
    expect(remaining(watchedAt(now), now, STALE_AFTER)).toEqual({ text: "About 1 day 17 hours left", stalled: false });
  });

  test("never runs negative — past the estimate it says so, and stays calm about it", () => {
    // A bulk retrieval overrunning ~48h is normal, not a fault. The row must not read "-3 hours left",
    // and must not keep promising a wait that has already elapsed.
    const now = REQUESTED + 60 * HOUR;
    expect(remaining(watchedAt(now), now, STALE_AFTER)).toEqual({
      text: "Taking longer than the usual ~48 hours. Still waiting.",
      stalled: false,
    });
  });

  test("the last minute doesn't round to '0 minutes left'", () => {
    const now = REQUESTED + 48 * HOUR - 20;
    expect(remaining(watchedAt(now), now, STALE_AFTER)).toEqual({ text: "Under a minute left", stalled: false });
  });

  test("only a thaw gets a countdown", () => {
    // Downloading, saved, stopped and unpaid rows have no thaw left to wait on — a clock on any of them
    // would be invented, which is the one thing this page refuses to do.
    for (const state of ["transferring", "saved", "canceled", "failed", "needsAuthorization"] as const) {
      expect(remaining(row({ state }), REQUESTED + HOUR, STALE_AFTER)).toBeNull();
    }
  });

  // ── the ceiling (the July-20-row regression, 2026-08-21) ──────────────────────────────────────────
  // "Still waiting" used to have no upper bound and no notion of freshness, so a transfer nothing had
  // touched in a month read exactly like a healthy 48-hour wait. These pin both ways out of that.

  test("a wait nobody has checked on in over a day stops claiming to be live", () => {
    const now = REQUESTED + 40 * 24 * HOUR;
    const stale = remaining(row({ lastStepAt: now - 30 * 24 * HOUR }), now, STALE_AFTER);
    expect(stale?.stalled).toBe(true);
    // Names the date we last looked rather than the date it was asked for — the whole point is that those
    // are different facts, and only the first says anything about whether this is still moving.
    expect(stale?.text).toContain("Last checked");
    expect(stale?.text).not.toContain("Still waiting");
  });

  test("a transfer no pass has ever touched says so, rather than borrowing a wait it can't vouch for", () => {
    const stale = remaining(row({ lastStepAt: null }), REQUESTED + 3 * HOUR, STALE_AFTER);
    expect(stale).toEqual({
      text: "Nothing has checked on this yet. It picks up on its own while the app is running.",
      stalled: true,
    });
  });

  test("even while we ARE checking, an overrun can't run forever — past 2x the estimate it reads stuck", () => {
    const now = REQUESTED + 97 * HOUR; // just past 2 x ~48h
    const stuck = remaining(watchedAt(now), now, STALE_AFTER);
    expect(stuck?.stalled).toBe(true);
    expect(stuck?.text).toContain("looks stuck");
  });

  test("the staleness threshold is the daemon's, not one the page keeps for itself", () => {
    // Same silence, two daemons. A slow-beat daemon (`COLDSTORE_INTERVAL`) says a longer gap is normal,
    // and the page must take its word for it rather than measure against a constant of its own.
    // 84h in — inside 2x the ~48h estimate, so the overrun rule stays out of it and only freshness decides.
    const now = REQUESTED + 84 * HOUR;
    const silent = row({ lastStepAt: now - 48 * HOUR });
    expect(remaining(silent, now, 24 * HOUR)?.stalled).toBe(true);
    expect(remaining(silent, now, 7 * 24 * HOUR)?.stalled).toBe(false);
  });

  test("staleness outranks the overrun — an unchecked row is unchecked, whatever the clock says", () => {
    // Both conditions true at once. The freshness answer wins because it is the one that explains the
    // other: we can't call a thaw overdue on evidence we haven't gathered.
    const now = REQUESTED + 200 * HOUR;
    expect(remaining(row({ lastStepAt: now - 5 * 24 * HOUR }), now, STALE_AFTER)?.text).toContain("Last checked");
  });
});

describe("restoreStall — the shared verdict", () => {
  test("names WHY, so each surface can say its own thing about the same fact", () => {
    const now = REQUESTED + 10 * 24 * HOUR;
    expect(restoreStall(row({ lastStepAt: null }), now, STALE_AFTER)).toBe("neverChecked");
    expect(restoreStall(row({ lastStepAt: now - 3 * 24 * HOUR }), now, STALE_AFTER)).toBe("unchecked");
    expect(restoreStall(watchedAt(now), now, STALE_AFTER)).toBe("overdue");
    expect(restoreStall(watchedAt(REQUESTED + 7 * HOUR), REQUESTED + 7 * HOUR, STALE_AFTER)).toBeNull();
  });

  test("agrees with the page's copy, so the button and the words can never disagree", () => {
    const now = REQUESTED + 7 * HOUR;
    expect(remaining(watchedAt(now), now, STALE_AFTER)?.stalled).toBe(false);
    expect(remaining(row({ lastStepAt: null }), now, STALE_AFTER)?.stalled).toBe(true);
  });

  test("a row that isn't waiting on a thaw is never stalled", () => {
    // `transferring` has its own live bar and `saved` is finished — neither has a wait to lose track of,
    // and offering "Ask again" (or dropping the file tree's overlay) on them would be nonsense.
    for (const state of ["transferring", "saved", "canceled", "failed", "needsAuthorization"] as const) {
      expect(restoreStall(row({ state, lastStepAt: null }), REQUESTED + 99 * HOUR, STALE_AFTER)).toBeNull();
    }
  });
});

describe("the transferring row's bar", () => {
  const GB = 1_000_000_000;
  const p = (over: Partial<RestoreProgress> = {}): RestoreProgress => ({
    bytes: 0,
    totalBytes: 50 * GB,
    samples: [],
    ...over,
  });

  test("no entry / no tick yet → indeterminate, and no readout invented", () => {
    // Just flipped to transferring, or the app opened mid-transfer: nothing true to show yet.
    expect(progressFraction(undefined)).toBeNull();
    expect(progressFraction(p())).toBeNull(); // bytes 0: same story
    expect(progressLine(p())).toBeNull();
  });

  test("the fraction is measured bytes over the row's own total, capped at 1", () => {
    expect(progressFraction(p({ bytes: 25 * GB }))).toBe(0.5);
    expect(progressFraction(p({ bytes: 51 * GB }))).toBe(1);
    // No denominator → no honest fraction (the bar shimmers instead of lying).
    expect(progressFraction(p({ bytes: 25 * GB, totalBytes: null }))).toBeNull();
  });

  test("the readout states only what's measured: bytes first, rate and ETA once there's signal", () => {
    // One tick: bytes alone — a rate from a single sample would be invented.
    expect(progressLine(p({ bytes: 1 * GB, samples: [{ t: 0, bytes: 1 * GB }] }))).toBe("1 GB of 50 GB");

    // Two ticks a second apart: 1 GB/s → rate and a real time-left appear.
    const line = progressLine(
      p({ bytes: 2 * GB, samples: [{ t: 0, bytes: 1 * GB }, { t: 1000, bytes: 2 * GB }] }),
    );
    expect(line).toStartWith("2 GB of 50 GB · 1 GB/s · ");
    expect(line).toContain("minute"); // 48 GB left at 1 GB/s — settled by duration.ts, not restated here
  });

  test("an unknown total still reports the bytes that have landed", () => {
    expect(progressLine(p({ bytes: 3 * GB, totalBytes: null, samples: [{ t: 0, bytes: 3 * GB }] }))).toBe("3 GB");
  });
});
