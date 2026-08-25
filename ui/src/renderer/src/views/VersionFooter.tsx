/**
 * The foot of Settings — what build this is, and whether it's the current one. Page-level (below the tab
 * content, on both tabs) because "which version am I running?" is a question about the app, not about one
 * subpage; it's the line a support conversation opens with.
 *
 * It's also the only place the update machinery is *visible* when it isn't demanding anything (PILLAR5).
 * {@link UpdateBanner} appears solely at `ready` — deliberate, it's an interruption — which leaves
 * checking, downloading and, most importantly, FAILING entirely invisible. A silent auto-updater that has
 * been erroring for weeks looks exactly like one that has nothing to do; here the two read differently,
 * and the manual check gives an answer instead of a button that seems to do nothing.
 */
import type { AppInfo, UpdateStatus } from "../../../shared/ipc.ts";
import { Button, Icon } from "../ui/primitives.tsx";

/** How the update line reads: its words, and whether it's a problem. `busy` disables the check button. */
export interface UpdateLine {
  text: string;
  tone: "quiet" | "accent" | "bad";
  busy: boolean;
}

/** "just now" inside a minute, else the clock time the answer came back. */
const checkedAt = (at: number, now: number): string =>
  now - at < 60_000 ? "just now" : `at ${new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;

/**
 * The update sentence for a given status. Pure (takes `now`) — the wording IS the feature here, so it's
 * tested rather than eyeballed. Takes the whole {@link AppInfo} because two of its fields, not one,
 * decide whether a check is even meaningful.
 *
 * Both short-circuits exist so the footer never offers a check that cannot succeed:
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
      // Named, not swallowed: this is the state that otherwise rots silently. The daemon's own words come
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

/** `api-staging.coldstorage.sh` from `https://api-staging.coldstorage.sh`. The lane is a task-supplied URL
 * every fetch has already gone through; if it didn't parse, nothing else in the app would be working. */
const laneHost = (url: string): string => new URL(url).host;

interface Props {
  /** Null until main's first-paint answer lands — a beat, during which we say nothing rather than guess. */
  appInfo: AppInfo | null;
  update: UpdateStatus;
  onCheck: () => void;
  onRestart: () => void;
}

export const VersionFooter = ({ appInfo, update, onCheck, onRestart }: Props): React.JSX.Element | null => {
  if (!appInfo) return null;
  const line = updateLine(update, appInfo, Date.now());
  return (
    <footer className="cs-about">
      <div className="cs-about-id">
        <Icon name="ac_unit" size={16} />
        <span>coldstorage</span>
        <span className="cs-mono">{appInfo.version}</span>
        {/* The zero-knowledge fact, as a footer mark rather than a card: it never changes and nothing acts
            on it, so it belongs beside the version line, not in a box of its own. Plain — no "safe". */}
        <span className="cs-about-encrypted">
          <Icon name="lock" size={14} />
          <Icon name="check" size={14} />
          encrypted
        </span>
      </div>
      <div className="cs-about-line">
        <span className={line.tone === "bad" ? "cs-about-bad" : line.tone === "accent" ? "cs-about-accent" : "cs-muted"}>
          {line.text}
        </span>
        {update.state === "ready" ? (
          <Button size="sm" icon="restart_alt" onClick={onRestart}>
            Restart to update
          </Button>
        ) : (
          // Two different absences. HIDDEN where a check is meaningless at all — a dev build, or an
          // install macOS will never update. Merely DISABLED while one is in flight, so the row doesn't
          // reflow out from under the pointer the moment you press it.
          appInfo.packaged &&
          appInfo.signature !== "other" && (
            <Button size="sm" icon="refresh" disabled={line.busy} onClick={onCheck}>
              Check for updates
            </Button>
          )
        )}
      </div>
      {/* Deliberately the quietest thing on the page, and only when it changes what every other answer
          here means: a build that came from the repo rather than a release — and, for one, WHICH backend
          this launch was given. A dev run's lane is a per-launch input, and a run on the wrong one is
          indistinguishable from a billing bug ("Free" on a paid account) unless the app says so. A
          packaged build's lane is baked and can't drift, so it says nothing. Host only — the scheme and
          path add nothing a person reads. */}
      {!appInfo.packaged && (
        <div className="cs-about-build">
          development build · <span className="cs-mono" title={appInfo.accountApiBaseUrl}>{laneHost(appInfo.accountApiBaseUrl)}</span>
        </div>
      )}
    </footer>
  );
};
