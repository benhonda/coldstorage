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
 * tested rather than eyeballed. `packaged` short-circuits everything: auto-update only runs in the signed,
 * packaged app, so a dev build must say so instead of offering a check that can never find anything.
 */
export const updateLine = (update: UpdateStatus, packaged: boolean, now: number): UpdateLine => {
  if (!packaged) return { text: "Auto-update is off in a development build.", tone: "quiet", busy: true };
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

interface Props {
  /** Null until main's first-paint answer lands — a beat, during which we say nothing rather than guess. */
  appInfo: AppInfo | null;
  update: UpdateStatus;
  onCheck: () => void;
  onRestart: () => void;
}

export const VersionFooter = ({ appInfo, update, onCheck, onRestart }: Props): React.JSX.Element | null => {
  if (!appInfo) return null;
  const line = updateLine(update, appInfo.packaged, Date.now());
  return (
    <footer className="cs-about">
      <div className="cs-about-id">
        <Icon name="ac_unit" size={16} />
        <span>coldstorage</span>
        <span className="cs-mono">{appInfo.version}</span>
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
          appInfo.packaged && (
            <Button size="sm" icon="refresh" disabled={line.busy} onClick={onCheck}>
              Check for updates
            </Button>
          )
        )}
      </div>
      {/* The support detail — deliberately the quietest thing on the page. Electron's version is what a
          "which build?" bug report actually needs beyond ours; `dev` marks a build that came from the repo
          rather than a release, which changes what every other answer here means. */}
      <div className="cs-about-build">
        Electron {appInfo.electron}
        {!appInfo.packaged && " · development build"}
      </div>
    </footer>
  );
};
