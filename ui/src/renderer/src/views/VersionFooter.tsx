/**
 * The foot of Settings — what build this is, and whether it's the current one. Page-level (below the tab
 * content, on both tabs) because "which version am I running?" is a question about the app, not about one
 * subpage; it's the line a support conversation opens with.
 *
 * It's also the only place in the renderer where the update machinery is *visible* when it isn't demanding
 * anything (PILLAR5). {@link UpdateBanner} appears solely at `ready` — deliberate, it's an interruption —
 * which leaves checking, downloading and, most importantly, FAILING entirely invisible. A silent
 * auto-updater that has been erroring for weeks looks exactly like one that has nothing to do; here the two
 * read differently, and the manual check gives an answer instead of a button that seems to do nothing.
 *
 * The same check is reachable from every screen via the app menu (`main/menu.ts`), which answers in a
 * native dialog using the same `updateLine` sentence — one wording, two doors.
 */
import type { AppInfo, UpdateStatus } from "../../../shared/ipc.ts";
import { updateLine } from "../../../shared/updateLine.ts";
import { Button, Icon } from "../ui/primitives.tsx";

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
