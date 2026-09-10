/**
 * The one sentence that says where the auto-updater stands. Shared by the Settings footer (renderer) and
 * the app menu's native result dialog (main) so a "Check for updates" started from either place gets the
 * same answer in the same words (PILLAR3). Pure — takes `now` — because the wording IS the feature here
 * and is tested rather than eyeballed (`updateLine.test.ts`).
 */
import type { AppInfo, UpdateStatus } from "./ipc.ts";

/** How the update line reads: its words, and whether it's a problem. `busy` disables a manual check. */
export interface UpdateLine {
  text: string;
  tone: "quiet" | "accent" | "bad";
  busy: boolean;
}

/** "just now" inside a minute, else the clock time the answer came back. */
const checkedAt = (at: number, now: number): string =>
  now - at < 60_000 ? "just now" : `at ${new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;

/**
 * The update sentence for a given status. Takes the whole {@link AppInfo} because two of its fields, not
 * one, decide whether a check is even meaningful.
 *
 * Both short-circuits exist so nothing ever offers a check that cannot succeed:
 *  - not packaged → a dev build, where the updater is an inert no-op port.
 *  - packaged but not Developer ID signed → the check and the download WILL work and the install will be
 *    refused by Squirrel.Mac. Saying "up to date" there would be the most misleading thing on the page,
 *    so this case is named before any status is consulted.
 */
export const updateLine = (update: UpdateStatus, app: Pick<AppInfo, "packaged" | "signature">, now: number): UpdateLine => {
  if (!app.packaged) return { text: "Auto-update is off in a development build.", tone: "quiet", busy: true };
  if (app.signature === "other") {
    // Not an error state — nothing has failed yet. It's a property of this install, and the only fix is
    // a reinstall, so the sentence says that rather than leaving a dead "Check for updates" to press.
    return { text: "This build isn't signed for distribution, so it can't auto-update. Reinstall from a release to fix it.", tone: "bad", busy: true };
  }
  switch (update.state) {
    case "checking":
      return { text: "Checking for updates…", tone: "quiet", busy: true };
    case "available":
      return { text: `Downloading ${update.version ? `version ${update.version}` : "a new version"}…`, tone: "accent", busy: true };
    case "downloading":
      return {
        text: `Downloading ${update.version ? `version ${update.version}` : "a new version"}… ${update.percent ?? 0}%`,
        tone: "accent",
        busy: true,
      };
    case "ready":
      return {
        text: `${update.version ? `Version ${update.version}` : "A new version"} is ready — it installs when you quit.`,
        tone: "accent",
        busy: true,
      };
    case "error":
      // Named, not swallowed: this is the state that otherwise rots silently. The updater's own words come
      // with it, since "couldn't check" and "couldn't download" want different fixes.
      return { text: update.error ? `Couldn't check for updates — ${update.error}` : "Couldn't check for updates.", tone: "bad", busy: false };
    case "idle":
      // `idle` is two different facts. With a stamp it's a real answer ("we asked, nothing newer"); without
      // one we've never had an answer, so it claims nothing.
      return update.lastCheckedAt == null
        ? { text: "Haven't checked for updates yet.", tone: "quiet", busy: false }
        : { text: `Up to date — checked ${checkedAt(update.lastCheckedAt, now)}.`, tone: "quiet", busy: false };
  }
};
