/**
 * The Settings footer's update sentence. This is copy that has to stay honest under states nobody looks
 * at by hand — a dev build that can't auto-update, a check that has never succeeded, and an updater
 * that's been failing quietly — so the wording is asserted rather than eyeballed.
 */
import { describe, expect, test } from "bun:test";
import type { UpdateStatus } from "../../../shared/ipc.ts";
import { updateLine } from "./VersionFooter.tsx";

const NOW = 1_700_000_000_000;
const status = (over: Partial<UpdateStatus> = {}): UpdateStatus => ({
  state: "idle",
  version: null,
  percent: null,
  error: null,
  lastCheckedAt: null,
  ...over,
});

describe("updateLine", () => {
  test("an unpackaged build says auto-update is off instead of offering a check", () => {
    const line = updateLine(status(), false, NOW);
    expect(line.text).toBe("Auto-update is off in a development build.");
    // `busy` is what hides/disables the button — a dev build must never look like it's checking.
    expect(line.busy).toBe(true);
  });

  test("idle with no successful check yet claims nothing", () => {
    expect(updateLine(status(), true, NOW).text).toBe("Haven't checked for updates yet.");
  });

  test("idle after a check says up to date, and how fresh that answer is", () => {
    expect(updateLine(status({ lastCheckedAt: NOW - 5_000 }), true, NOW).text).toBe("Up to date — checked just now.");
    // Older than a minute, "just now" would be a small lie — it gives the clock time instead.
    const stale = updateLine(status({ lastCheckedAt: NOW - 3 * 60 * 60_000 }), true, NOW).text;
    expect(stale).toStartWith("Up to date — checked at ");
    expect(stale).not.toContain("just now");
  });

  test("a download in flight names the version and its progress", () => {
    expect(updateLine(status({ state: "downloading", version: "0.2.0", percent: 43 }), true, NOW).text).toBe(
      "Downloading version 0.2.0… 43%",
    );
  });

  test("a ready build says it installs on quit (the banner offers the restart)", () => {
    const line = updateLine(status({ state: "ready", version: "0.2.0" }), true, NOW);
    expect(line.text).toBe("Version 0.2.0 is ready — it installs when you quit.");
    expect(line.tone).toBe("accent");
  });

  test("a failing updater says so in the updater's own words, and stays retryable", () => {
    const line = updateLine(status({ state: "error", error: "network down" }), true, NOW);
    expect(line.text).toBe("Couldn't check for updates — network down");
    expect(line.tone).toBe("bad");
    // NOT busy: the whole point of surfacing the failure is that the user can try again.
    expect(line.busy).toBe(false);
  });
});
