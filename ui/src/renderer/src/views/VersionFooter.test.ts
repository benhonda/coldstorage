/**
 * The Settings footer's update sentence. This is copy that has to stay honest under states nobody looks
 * at by hand — a dev build that can't auto-update, a check that has never succeeded, and an updater
 * that's been failing quietly — so the wording is asserted rather than eyeballed.
 */
import { describe, expect, test } from "bun:test";
import type { AppInfo, UpdateStatus } from "../../../shared/ipc.ts";
import { updateLine } from "./VersionFooter.tsx";

const NOW = 1_700_000_000_000;

/** The ordinary case: a real release install, where the update status is the only thing that varies. */
const RELEASE: Pick<AppInfo, "packaged" | "signature"> = { packaged: true, signature: "developer-id" };
const DEV: Pick<AppInfo, "packaged" | "signature"> = { packaged: false, signature: "unknown" };
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
    const line = updateLine(status(), DEV, NOW);
    expect(line.text).toBe("Auto-update is off in a development build.");
    // `busy` is what hides/disables the button — a dev build must never look like it's checking.
    expect(line.busy).toBe(true);
  });

  test("idle with no successful check yet claims nothing", () => {
    expect(updateLine(status(), RELEASE, NOW).text).toBe("Haven't checked for updates yet.");
  });

  test("idle after a check says up to date, and how fresh that answer is", () => {
    expect(updateLine(status({ lastCheckedAt: NOW - 5_000 }), RELEASE, NOW).text).toBe("Up to date — checked just now.");
    // Older than a minute, "just now" would be a small lie — it gives the clock time instead.
    const stale = updateLine(status({ lastCheckedAt: NOW - 3 * 60 * 60_000 }), RELEASE, NOW).text;
    expect(stale).toStartWith("Up to date — checked at ");
    expect(stale).not.toContain("just now");
  });

  test("a download in flight names the version and its progress", () => {
    expect(updateLine(status({ state: "downloading", version: "0.2.0", percent: 43 }), RELEASE, NOW).text).toBe(
      "Downloading version 0.2.0… 43%",
    );
  });

  test("a ready build says it installs on quit (the banner offers the restart)", () => {
    const line = updateLine(status({ state: "ready", version: "0.2.0" }), RELEASE, NOW);
    expect(line.text).toBe("Version 0.2.0 is ready — it installs when you quit.");
    expect(line.tone).toBe("accent");
  });

  test("an unsigned install says it can't update at all, whatever the status claims", () => {
    // The regression this exists for: an ad-hoc signed local build sat in /Applications for a month
    // reporting "Up to date" while every install was being refused by Squirrel.Mac.
    const line = updateLine(status({ lastCheckedAt: NOW - 5_000 }), { packaged: true, signature: "other" }, NOW);
    expect(line.text).toBe("This build isn't signed for distribution, so it can't auto-update. Reinstall from a release to fix it.");
    expect(line.tone).toBe("bad");
    // Busy: a check WOULD succeed here, which is exactly why offering one would mislead.
    expect(line.busy).toBe(true);
  });

  test("an unknown signature is not treated as unsigned", () => {
    // "unknown" is what a non-macOS or uninspectable build reports. It must fall through to the normal
    // status wording rather than accusing a fine install of being unsignable.
    expect(updateLine(status(), { packaged: true, signature: "unknown" }, NOW).text).toBe("Haven't checked for updates yet.");
  });

  test("a failing updater says so in the updater's own words, and stays retryable", () => {
    const line = updateLine(status({ state: "error", error: "network down" }), RELEASE, NOW);
    expect(line.text).toBe("Couldn't check for updates — network down");
    expect(line.tone).toBe("bad");
    // NOT busy: the whole point of surfacing the failure is that the user can try again.
    expect(line.busy).toBe(false);
  });
});
