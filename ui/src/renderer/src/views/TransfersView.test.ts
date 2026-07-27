/**
 * The Transfers countdown + the transferring row's live bar — which row gets a clock, what the readout
 * says as the signal firms up, and what the estimate's overrun reads like. The PHRASING of durations is
 * `ui/duration.ts`'s and tested there; this covers only the decisions this page makes.
 */
import { describe, expect, test } from "bun:test";
import type { RestoreRow } from "../../../shared/ipc.ts";
import type { RestoreProgress } from "../state/reducer.ts";
import { progressFraction, progressLine, remaining } from "./TransfersView.tsx";

const HOUR = 3600;
const REQUESTED = 1_700_000_000;

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
  completedAt: null,
  error: null,
  typicalWait: "~48 hours",
  typicalWaitSeconds: 48 * HOUR,
  freeUntil: null,
  resumable: false,
  ...over,
});

describe("remaining", () => {
  test("counts down from the tier's own estimate", () => {
    expect(remaining(row(), REQUESTED + 7 * HOUR)).toBe("About 1 day 17 hours left");
  });

  test("never runs negative — past the estimate it says so, and stays calm about it", () => {
    // A bulk retrieval overrunning ~48h is normal, not a fault. The row must not read "-3 hours left",
    // and must not keep promising a wait that has already elapsed.
    const late = remaining(row(), REQUESTED + 60 * HOUR);
    expect(late).toBe("Taking longer than the usual ~48 hours. Still waiting.");
  });

  test("the last minute doesn't round to '0 minutes left'", () => {
    expect(remaining(row(), REQUESTED + 48 * HOUR - 20)).toBe("Under a minute left");
  });

  test("only a thaw gets a countdown", () => {
    // Downloading, saved, stopped and unpaid rows have no thaw left to wait on — a clock on any of them
    // would be invented, which is the one thing this page refuses to do.
    for (const state of ["transferring", "saved", "canceled", "failed", "needsAuthorization"] as const) {
      expect(remaining(row({ state }), REQUESTED + HOUR)).toBeNull();
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
