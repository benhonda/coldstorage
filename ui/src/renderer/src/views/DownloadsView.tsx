/**
 * **Downloads** — every request this Mac has made to get files back, active and past, **one row per
 * request**. Ask for a folder of 300 photos and you get one row ("Photos"), not 300; the daemon's journal
 * stays per-file underneath (see `downloads/model.ts` for the fold and why `jobId` is the group key).
 *
 * This page exists because a download is a days-long thing with money attached, and it used to have
 * nowhere to live: the only sign of one was a count in the sidebar foot and a popover listing files, both
 * built from renderer memory. Sign out, or quit the app, and an in-flight download someone had paid for
 * simply disappeared. Now the daemon's journal owns them and this page reads the list.
 *
 * The states are named honestly, and only real movement gets a bar. A download is **pending** for the
 * ~48 hours deep storage takes to wake the files (nothing moves — a bar there would be invented, so the
 * wait gets a countdown instead), then **downloading** while bytes actually land (a real, measured bar:
 * the daemon streams the download frame-by-frame and narrates plaintext bytes via `restoreProgress`
 * events → the store's `restoreProgress` slice), then **done**. (The wire keeps its own engineering
 * names for the same lifecycle — `pending`/`transferring`/`saved` on `RestoreState` — this STATE map is
 * the one translation point.)
 *
 * What a waiting row CAN honestly say is how much of the wait is left, and that's the one thing someone
 * actually wants from this page. The daemon hands over `typicalWaitSeconds` alongside the prose
 * `typicalWait`, both from the tier it quoted at, so the countdown here is the backend's own estimate
 * ticking down rather than a number the renderer made up. The phrase itself comes from `ui/duration.ts`,
 * shared with the deposit banner — "how much longer" is one question and gets one voice. Rate + ETA on a
 * downloading row are the same shared math (`throughput`/`etaSeconds`) the deposit banner smooths its
 * own bar with — one mechanism, both directions.
 */
import { useEffect, useState } from "react";
import type { ColdstoreApi, RestoreRow, RestoreStall, RestoreState } from "../../../shared/ipc.ts";
import { isActiveRestore, restoreStall } from "../../../shared/ipc.ts";
import { etaSeconds, throughput, type RestoreProgress } from "../state/reducer.ts";
import { Badge, Button, EmptyState, Icon, Modal } from "../ui/primitives.tsx";
import { Page } from "../ui/layout.tsx";
import { timeLeft, timeLeftSentence } from "../ui/duration.ts";
import { baseName, formatBytes } from "./files/model.ts";
import {
  commonOutDir,
  folderOf,
  groupDownloads,
  groupFraction,
  latestPendingRow,
  type DownloadGroup,
} from "./downloads/model.ts";
import type { Exec } from "./types.ts";

type Tone = "neutral" | "accent" | "warning" | "success" | "danger";

/** Unix seconds, re-read on an interval, so every countdown on the page moves without the daemon having
 * to push anything. 15s: fine enough that a "3 minutes left" row doesn't visibly lag, cheap enough to
 * leave running (one `setState` on a page with a handful of rows). */
const useNow = (everyMs = 15_000): number => {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
};

/** Just the date — for a deadline days out, the hour is noise. */
const day = (unixSeconds: number): string =>
  new Date(unixSeconds * 1000).toLocaleDateString("en-US", { month: "long", day: "numeric" });

/** What a waiting row says about its wait, and whether that wait is still one the page can stand behind.
 * `stalled` drives the tone, the icon, and whether the row offers a way out — it is the difference between
 * narrating a wait and admitting we've lost track of one. */
export interface WaitNote {
  text: string;
  stalled: boolean;
}

/** How each stall reads to the user. The VERDICT is `restoreStall`'s — shared, because the file tree
 * answers to it too; only the wording is this page's. */
const STALL_TEXT: Record<RestoreStall, (r: RestoreRow) => string> = {
  neverChecked: () => "Nothing has checked on this yet. It picks up on its own while the app is running.",
  unchecked: (r) => `Last checked ${day(r.lastStepAt ?? 0)}. It picks up on its own while the app is running.`,
  overdue: (r) =>
    `Well past the usual ${r.typicalWait}, and still frozen — this one looks stuck. Ask for it again to start over.`,
};

/**
 * How much of the thaw is left, for a row that's waiting on one. Null for every other state: a download
 * that's moving, done, stopped or unpaid has no thaw to count down, and nothing here should invent one
 * for it.
 *
 * Three readings, in the order they stop being true:
 *
 * 1. **Counting down** — inside the estimate. The daemon's own number, ticking.
 * 2. **Over the estimate, but we're watching** — a bulk retrieval that runs past ~48 hours is normal and
 *    not a fault, so this says "still waiting" without alarm and without pretending the estimate stands.
 * 3. **Stalled** — `restoreStall` says so, and the page stops describing a thaw it can't vouch for.
 *
 * (3) is what this could not express at all before, and its absence was a real lie: with `requestedAt` as
 * the only clock, reading (2) had no upper bound, so a transfer nothing had touched since July said
 * "Taking longer than usual. Still waiting." indefinitely — cheerful, reassuring, and false.
 */
export const remaining = (r: RestoreRow, now: number, staleAfterSeconds: number): WaitNote | null => {
  if (r.state !== "pending") return null;

  const stall = restoreStall(r, now, staleAfterSeconds);
  if (stall) return { text: STALL_TEXT[stall](r), stalled: true };

  const left = r.requestedAt + r.typicalWaitSeconds - now;
  if (left > 0) {
    const sentence = timeLeftSentence(left);
    return sentence ? { text: sentence, stalled: false } : null;
  }
  return { text: `Taking longer than the usual ${r.typicalWait}. Still waiting.`, stalled: false };
};

/** How each state reads to the user — the wire→page translation (see the header). `pending` rather than
 * "downloading" for the thaw, because for those ~48 hours no byte is moving and the label must not claim
 * otherwise; the note beneath says what IS happening (deep storage waking up). */
const STATE: Record<RestoreState, { label: string; tone: Tone; icon: string }> = {
  needsAuthorization: { label: "Needs payment", tone: "warning", icon: "credit_card" },
  pending: { label: "Pending", tone: "warning", icon: "hourglass_top" },
  transferring: { label: "Downloading", tone: "accent", icon: "arrow_circle_down" },
  saved: { label: "Done", tone: "success", icon: "download_done" },
  canceled: { label: "Stopped", tone: "neutral", icon: "cancel" },
  failed: { label: "Didn't finish", tone: "danger", icon: "error" },
};

/** Date + time — a download is a same-week thing, so the hour is the useful part. */
const when = (unixSeconds: number | null): string => {
  if (!unixSeconds) return "—";
  return new Date(unixSeconds * 1000).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
};

/**
 * The downloading row's readout — "1.2 GB of 50 GB · 42 MB/s · About 20 minutes left" — from its live
 * progress entry. Null until the first tick lands (nothing true to say yet) and piece by piece as the
 * signal firms up: bytes always, rate once two samples exist, ETA once there's a rate and a total. Pure
 * and exported for the tests; only states what's measured, never invents precision (the same contract as
 * the deposit banner's line).
 */
export const progressLine = (p: RestoreProgress): string | null => {
  if (p.bytes <= 0) return null;
  const parts: string[] = [
    p.totalBytes != null ? `${formatBytes(p.bytes)} of ${formatBytes(p.totalBytes)}` : formatBytes(p.bytes),
  ];
  const rate = throughput(p.samples);
  if (rate != null) parts.push(`${formatBytes(rate)}/s`);
  const eta = etaSeconds(p.samples, p.bytes, p.totalBytes);
  const left = eta != null ? timeLeft(eta) : "";
  if (left) parts.push(left);
  return parts.join(" · ");
};

/** The measured fraction for the bar, or null when it can't be honest yet (no tick, or no denominator) —
 * null renders the indeterminate sheen, exactly like the deposit banner before its first part lands. */
export const progressFraction = (p: RestoreProgress | undefined): number | null =>
  p && p.totalBytes != null && p.bytes > 0 ? Math.min(1, p.bytes / p.totalBytes) : null;

/** The bar + readout under a downloading row. Indeterminate until there's something honest to draw
 * (just flipped, or the app just opened mid-download — the next tick lands within a second). */
const DownloadBar = ({ fraction, line }: { fraction: number | null; line: string | null }): React.JSX.Element => (
  <div className="cs-download-progress">
    <div
      className={`cs-bar-track${fraction == null ? " cs-bar-track--indeterminate" : ""}`}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={fraction == null ? undefined : 100}
      aria-valuenow={fraction == null ? undefined : Math.round(fraction * 100)}
    >
      <div className="cs-bar-fill" style={fraction == null ? undefined : { width: `${fraction * 100}%` }} />
    </div>
    {line && <div className="cs-bar-meta">{line}</div>}
  </div>
);

/** The one-line explanation under a file row. Only says something when there IS something to say — a
 * downloading row that's behaving needs no commentary. */
const detail = (r: RestoreRow): string | null => {
  // An error on a row that's still ACTIVE means a transient fault the daemon is retrying (a network blip
  // during the thaw, say). Say so: the download is fine and still going, but a silent hiccup that leaves
  // the page reading "Pending" for an extra hour with no explanation is the sort of invisible work the
  // user deserves to see (CORE9).
  if (r.error && isActiveRestore(r.state)) return `Hit a snag (${r.error}) — still trying.`;

  switch (r.state) {
    case "pending":
      // The badge says "Pending"; this says what pending actually is — and the promise that matters.
      return "Deep storage is waking this up. You can close the app — it keeps going.";
    case "needsAuthorization":
      return "This one isn't paid for, so deep storage won't release it. Ask for it again to get a new price.";
    case "transferring":
      return null;
    case "saved":
      return `Saved to ${folderOf(r.out)}`;
    case "canceled":
      // `freeUntil` is the end of the 5-day window the thaw already bought. Naming the date matters more
      // here than anywhere else on the page: after it passes, picking this back up costs money again.
      return r.resumable
        ? r.freeUntil
          ? `You stopped this. The copy stays warm until ${day(r.freeUntil)}, so picking it back up before then costs nothing.`
          : "You stopped this. The copy is still warm, so picking it back up costs nothing."
        : "You stopped this. Asking again will be a new request.";
    case "failed":
      return r.error ?? "Something went wrong.";
  }
};

/** The group-level line under a multi-file row — same contract as {@link detail}, said for the whole
 * request. Per-file specifics (which file snagged, where each one saved) live on the expanded rows. */
const groupDetail = (g: DownloadGroup): string | null => {
  switch (g.state) {
    case "pending":
      return "Deep storage is waking these files up. You can close the app — it keeps going.";
    case "needsAuthorization":
      return "This isn't paid for, so deep storage won't release it. Ask for it again to get a new price.";
    case "transferring":
      return null;
    case "saved":
      return `Saved to ${commonOutDir(g.rows)}`;
    case "canceled": {
      const warm = g.rows.find((r) => r.resumable);
      return warm
        ? warm.freeUntil
          ? `You stopped this. The copies stay warm until ${day(warm.freeUntil)}, so picking it back up before then costs nothing.`
          : "You stopped this. The copies are still warm, so picking it back up costs nothing."
        : "You stopped this. Asking again will be a new request.";
    }
    case "failed":
      return `${g.failedCount} of ${g.rows.length} files didn't finish.`;
  }
};

/** What the action buttons operate on: a whole request, or one file of it (as a solo group). Every
 * action fans out to per-row daemon commands — the journal underneath is per-file, and stays that way. */
interface RowActions {
  onStop: (g: DownloadGroup) => void;
  onResume: (g: DownloadGroup) => void;
  onForget: (g: DownloadGroup) => void;
  onReveal: (g: DownloadGroup) => void;
  onRequestAgain: (g: DownloadGroup) => void;
}

/** The action strip, shared by single-file rows and grouped rows — the conditions read off the group's
 * headline state, so one file and three hundred behave identically. */
const Actions = ({
  g,
  a,
  stalled = false,
}: {
  g: DownloadGroup;
  a: RowActions;
  /** This request's wait has stopped being one we can vouch for (see {@link remaining}). Earns the same
   * "Ask again" the unpaid state gets: both are transfers going nowhere on their own, and a row that tells
   * you it's stuck while offering only "Stop" is a dead end wearing a diagnosis. */
  stalled?: boolean;
}): React.JSX.Element => {
  const anyResumable = g.rows.some((r) => r.resumable);
  return (
    <div className="cs-download-actions">
      {g.state === "saved" && (
        <Button variant="secondary" size="sm" icon="folder_open" onClick={() => a.onReveal(g)}>
          Show in Finder
        </Button>
      )}
      {(g.state === "needsAuthorization" || stalled) && (
        <Button variant="secondary" size="sm" icon="refresh" onClick={() => a.onRequestAgain(g)}>
          Ask again
        </Button>
      )}
      {(g.state === "canceled" || g.state === "failed") && anyResumable && (
        <Button variant="secondary" size="sm" icon="play_arrow" onClick={() => a.onResume(g)}>
          Pick back up
        </Button>
      )}
      {g.state === "failed" && !anyResumable && (
        <Button variant="secondary" size="sm" icon="refresh" onClick={() => a.onRequestAgain(g)}>
          Ask again
        </Button>
      )}
      {isActiveRestore(g.state) ? (
        <Button variant="ghost" size="sm" onClick={() => a.onStop(g)}>
          Stop
        </Button>
      ) : (
        <Button variant="ghost" size="sm" onClick={() => a.onForget(g)}>
          Remove
        </Button>
      )}
    </div>
  );
};

/** The wait line under a waiting row — a countdown, or the admission that we've lost track of it. */
const WaitLine = ({ wait }: { wait: WaitNote }): React.JSX.Element => (
  <div className={`cs-download-eta${wait.stalled ? " cs-download-eta--stalled" : ""}`}>
    <Icon name={wait.stalled ? "error_outline" : "schedule"} size={16} />
    {wait.text}
  </div>
);

/** A one-file group for a row acting alone (a single-file request, or one member of an expanded group) —
 * so file rows and request rows share the action path instead of maintaining two. */
const soloGroup = (r: RestoreRow): DownloadGroup => groupDownloads([r])[0]!;

/** One FILE — a single-file request, or one member of an expanded group (`child`). */
const FileRow = ({
  r,
  g,
  now,
  staleAfter,
  progress,
  child = false,
  actions,
}: {
  r: RestoreRow;
  /** The group this row acts as when its buttons are pressed — its own solo fold, or the whole request
   * for a single-file one (the two are identical there). */
  g: DownloadGroup;
  /** Ticking clock from the page, so every row's countdown moves off one interval rather than N. */
  now: number;
  /** The daemon's own silence window ({@link Status.staleAfterSeconds}); `Infinity` with no snapshot. */
  staleAfter: number;
  /** This row's live download progress — present only while it's `transferring` (the reducer prunes it
   * the moment the row's state moves on). */
  progress: RestoreProgress | undefined;
  child?: boolean;
  actions: RowActions;
}): React.JSX.Element => {
  const s = STATE[r.state];
  const note = detail(r);
  const wait = remaining(r, now, staleAfter);
  return (
    <div className={`cs-download${child ? " cs-download--child" : ""}`}>
      <span className={`cs-download-icon cs-download-icon--${s.tone}`}>
        <Icon name={s.icon} size={20} />
      </span>
      <div className="cs-download-main">
        <div className="cs-download-head">
          <span className="cs-download-name" title={r.relativePath}>
            {baseName(r.relativePath)}
          </span>
          <Badge tone={s.tone}>{s.label}</Badge>
        </div>
        <div className="cs-download-meta">
          {formatBytes(r.bytes)} · asked {when(r.requestedAt)}
          {r.state === "saved" && r.completedAt ? ` · saved ${when(r.completedAt)}` : ""}
        </div>
        {/* The headline fact for a waiting download, so it reads above the standing explanation rather
            than buried inside it. A stalled wait swaps the clock for a warning: the line is no longer a
            countdown, and dressing it as one would undercut what it now says. */}
        {wait && <WaitLine wait={wait} />}
        {r.state === "transferring" && (
          <DownloadBar fraction={progressFraction(progress)} line={progress ? progressLine(progress) : null} />
        )}
        {note && <div className="cs-download-note">{note}</div>}
      </div>
      <Actions g={g} a={actions} stalled={wait?.stalled === true} />
    </div>
  );
};

/** One REQUEST of several files — "Photos · 300 files", expandable to the files inside it. */
const GroupRow = ({
  g,
  now,
  staleAfter,
  progress,
  actions,
}: {
  g: DownloadGroup;
  now: number;
  staleAfter: number;
  progress: Record<string, RestoreProgress>;
  actions: RowActions;
}): React.JSX.Element => {
  const [open, setOpen] = useState(false);
  const s = STATE[g.state];
  const note = groupDetail(g);
  // The countdown speaks for the slowest pending file — the request is done thawing when it is. Its
  // verdict speaks for the whole request too: if the file we're waiting longest on has gone unchecked,
  // every file behind it in the same pass has as well.
  const slowest = latestPendingRow(g.rows);
  const wait = slowest ? remaining(slowest, now, staleAfter) : null;
  return (
    <div className="cs-download-request">
      <div className="cs-download">
        <button
          type="button"
          className="cs-download-expand"
          aria-expanded={open}
          aria-label={open ? "Hide files" : "Show files"}
          onClick={() => setOpen((v) => !v)}
        >
          <Icon name={open ? "expand_more" : "chevron_right"} size={20} />
        </button>
        <span className={`cs-download-icon cs-download-icon--${s.tone}`}>
          <Icon name={s.icon} size={20} />
        </span>
        <div className="cs-download-main">
          <div className="cs-download-head">
            {/* A folderless multi-select has no honest name (label is null), so the count IS the name —
                and then the meta line doesn't repeat it. */}
            <span className="cs-download-name">{g.label ?? `${g.rows.length} files`}</span>
            <Badge tone={s.tone}>{s.label}</Badge>
          </div>
          <div className="cs-download-meta">
            {g.label != null ? `${g.rows.length} files · ` : ""}
            {formatBytes(g.bytes)} · asked {when(g.requestedAt)}
            {g.state === "saved" && g.completedAt ? ` · saved ${when(g.completedAt)}` : ""}
          </div>
          {wait && <WaitLine wait={wait} />}
          {g.state === "transferring" && (
            // The request's bar is measured too: bytes saved + bytes mid-flight over its total (see
            // `groupFraction`). The line counts files — the truer signal for a many-small-files ask.
            <DownloadBar
              fraction={groupFraction(g, progress)}
              line={`${g.doneCount} of ${g.rows.length} files done`}
            />
          )}
          {note && <div className="cs-download-note">{note}</div>}
        </div>
        <Actions g={g} a={actions} stalled={wait?.stalled === true} />
      </div>
      {open && (
        <div className="cs-download-children">
          {g.rows.map((r) => (
            <FileRow
              key={r.id}
              r={r}
              g={soloGroup(r)}
              now={now}
              staleAfter={staleAfter}
              progress={progress[r.id]}
              child
              actions={actions}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export const DownloadsView = ({
  api,
  exec,
  restores,
  restoreProgress,
  staleAfter,
  onRequestAgain,
}: {
  api: ColdstoreApi;
  exec: Exec;
  restores: readonly RestoreRow[];
  /** The daemon's own silence window (`Status.staleAfterSeconds`) — how long a transfer may go untouched
   * before this page stops calling its wait live. `Infinity` when there's no daemon snapshot to read it
   * from: with no idea how often it promised to look, silence proves nothing. */
  staleAfter: number;
  /** Live download progress by row id (the store's `restoreProgress` slice) — feeds each downloading
   * row's bar. */
  restoreProgress: Record<string, RestoreProgress>;
  /** Send the user back to My Files with the request dialog open for these files — the way out of
   * `needsAuthorization` (and of a download whose thaw window closed), both of which need a fresh price.
   * Takes the LIST because a grouped row re-asks every file that needs re-buying, not one. */
  onRequestAgain: (fileIds: string[]) => void;
}): React.JSX.Element => {
  // The request awaiting a stop confirmation. Stopping is worth a confirm because it can't be undone for
  // free once the thaw window closes, and because the money question needs answering before, not after.
  const [stopping, setStopping] = useState<DownloadGroup | null>(null);
  const now = useNow();

  const groups = groupDownloads(restores);
  const active = groups.filter((g) => isActiveRestore(g.state));
  const past = groups.filter((g) => !isActiveRestore(g.state));

  // Every action fans out to the per-file commands the daemon actually has — the journal is per-file,
  // and each command answers with the whole list, so the last reply reconciles everything.
  const actions: RowActions = {
    onStop: setStopping,
    onResume: (g) => {
      for (const r of g.rows) if (r.resumable) exec(() => api.request("resumeRestore", { id: r.id }));
    },
    onForget: (g) => {
      for (const r of g.rows) exec(() => api.request("forgetRestore", { id: r.id }));
    },
    onReveal: (g) => void api.revealInFinder(g.rows.length === 1 ? (g.rows[0]?.out ?? "/") : commonOutDir(g.rows)),
    // Re-ask exactly the files that need re-buying (unpaid, failed past their window, or waiting on a thaw
    // we've stopped being able to vouch for) — not the whole request; the files that already landed are
    // done and would only pad the new quote. Re-asking a still-`pending` file is safe by construction:
    // `requestRestore` supersedes any in-flight transfer of the same file, so the stuck row is stopped
    // rather than left to sit in "In progress" beside the one replacing it.
    onRequestAgain: (g) =>
      onRequestAgain(
        g.rows
          .filter(
            (r) =>
              r.state === "needsAuthorization" ||
              (r.state === "failed" && !r.resumable) ||
              (r.state === "pending" && restoreStall(r, now, staleAfter) !== null),
          )
          .map((r) => r.fileId),
      ),
  };

  const confirmStop = (): void => {
    const g = stopping;
    setStopping(null);
    if (g) for (const r of g.rows) if (isActiveRestore(r.state)) exec(() => api.request("cancelRestore", { id: r.id }));
  };

  return (
    <Page title="Downloads">
      {restores.length === 0 ? (
        <EmptyState
          icon="download"
          title="No downloads yet"
          description="When you ask for files back, they show up here while they're on their way."
        />
      ) : (
        <>
          {active.length > 0 && (
            <section className="cs-downloads-group">
              <h2 className="cs-downloads-heading">In progress</h2>
              {active.map((g) =>
                g.rows.length === 1 ? (
                  <FileRow
                    key={g.key}
                    r={g.rows[0]!}
                    g={g}
                    now={now}
                    staleAfter={staleAfter}
                    progress={restoreProgress[g.rows[0]!.id]}
                    actions={actions}
                  />
                ) : (
                  <GroupRow key={g.key} g={g} now={now} staleAfter={staleAfter} progress={restoreProgress} actions={actions} />
                ),
              )}
            </section>
          )}
          {past.length > 0 && (
            <section className="cs-downloads-group">
              <h2 className="cs-downloads-heading">Earlier</h2>
              {past.map((g) =>
                g.rows.length === 1 ? (
                  <FileRow key={g.key} r={g.rows[0]!} g={g} now={now} staleAfter={staleAfter} progress={undefined} actions={actions} />
                ) : (
                  <GroupRow key={g.key} g={g} now={now} staleAfter={staleAfter} progress={restoreProgress} actions={actions} />
                ),
              )}
            </section>
          )}
        </>
      )}

      {stopping && (
        <Modal
          title="Stop this download?"
          icon="cancel"
          onClose={() => setStopping(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setStopping(null)}>
                Keep going
              </Button>
              <Button variant="primary" onClick={confirmStop}>
                Stop it
              </Button>
            </>
          }
        >
          {/* The money has to be said plainly and up front. A thaw can't be called back once it's started,
              so "cancel" here does not mean "undo the charge" — and letting someone find that out
              afterwards would be the dishonest version of this dialog. The group label reads naturally in
              both shapes: "waking beach.jpg up" and "waking Photos up". */}
          {stopping.state === "needsAuthorization" ? (
            <p>Nothing has been paid for this one, so stopping it costs you nothing.</p>
          ) : (
            <>
              <p>
                Deep storage is already waking {stopping.label ?? "these files"} up, and we can&apos;t
                call that back — so stopping won&apos;t refund what it cost.
              </p>
              <p>
                Your {stopping.rows.length === 1 ? "copy stays" : "copies stay"} ready for 5 days from when
                the thaw finishes. Picking it back up in that window is free.
              </p>
            </>
          )}
        </Modal>
      )}
    </Page>
  );
};
