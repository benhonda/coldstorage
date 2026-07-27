/**
 * The Transfers countdown. Pure functions over a journal row, so they're testable without a DOM — and
 * worth testing, because every failure mode here is one the user reads as a lie: a clock that runs
 * negative, a "1 days left", or a wait that keeps promising ~48 hours after 60 have passed.
 */
import { describe, expect, test } from "bun:test";
import type { RestoreRow } from "../../../shared/ipc.ts";
import { humanDuration, remaining } from "./TransfersView.tsx";

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

describe("humanDuration", () => {
  test("singulars don't read like a bug", () => {
    expect(humanDuration(60)).toBe("1 minute");
    expect(humanDuration(HOUR)).toBe("1 hour");
    expect(humanDuration(25 * HOUR)).toBe("1 day 1 hour");
  });

  test("drops the hours when a day lands flat", () => {
    expect(humanDuration(48 * HOUR)).toBe("2 days");
  });

  test("crosses each unit at the right place", () => {
    expect(humanDuration(45 * 60)).toBe("45 minutes");
    expect(humanDuration(2 * HOUR)).toBe("2 hours");
    expect(humanDuration(41 * HOUR)).toBe("1 day 17 hours");
  });
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
    expect(remaining(row(), REQUESTED + 48 * HOUR - 20)).toBe("Less than a minute left");
  });

  test("only a thaw gets a countdown", () => {
    // Downloading, saved, stopped and unpaid rows have no thaw left to wait on — a clock on any of them
    // would be invented, which is the one thing this page refuses to do.
    for (const state of ["transferring", "saved", "canceled", "failed", "needsAuthorization"] as const) {
      expect(remaining(row({ state }), REQUESTED + HOUR)).toBeNull();
    }
  });
});
