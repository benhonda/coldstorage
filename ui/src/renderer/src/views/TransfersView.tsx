/**
 * **Transfers** — every copy this Mac has asked for, active and past.
 *
 * This page exists because a transfer is a days-long thing with money attached, and it used to have
 * nowhere to live: the only sign of one was a count in the sidebar foot and a popover listing files, both
 * built from renderer memory. Sign out, or quit the app, and an in-flight transfer someone had paid for
 * simply disappeared. Now the daemon's journal owns them and this page reads the list.
 *
 * The states are named, and only real movement gets a bar. For the ~48 hours of a thaw, Deep Archive
 * reports "warming" or "ready" and nothing in between — a bar there would be invented, so the wait is
 * `pending` and gets a countdown instead. `transferring` is reserved for when bytes actually move, and
 * NOW that state earns a real determinate bar: the daemon streams the download frame-by-frame and
 * narrates plaintext bytes as they land (`restoreProgress` events → the store's `restoreProgress`
 * slice), so the fraction here is measured, never invented.
 *
 * What a waiting row CAN honestly say is how much of the wait is left, and that's the one thing someone
 * actually wants from this page. The daemon hands over `typicalWaitSeconds` alongside the prose
 * `typicalWait`, both from the tier it quoted at, so the countdown here is the backend's own estimate
 * ticking down rather than a number the renderer made up. The phrase itself comes from `ui/duration.ts`,
 * shared with the deposit banner — "how much longer" is one question and gets one voice. Rate + ETA on a
 * transferring row are the same shared math (`throughput`/`etaSeconds`) the deposit banner smooths its
 * own bar with — one mechanism, both directions.
 */
import { useEffect, useState } from "react";
import type { ColdstoreApi, RestoreRow, RestoreState } from "../../../shared/ipc.ts";
import { isActiveRestore } from "../../../shared/ipc.ts";
import { etaSeconds, throughput, type RestoreProgress } from "../state/reducer.ts";
import { Badge, Button, EmptyState, Icon, Modal } from "../ui/primitives.tsx";
import { Page } from "../ui/layout.tsx";
import { timeLeft, timeLeftSentence } from "../ui/duration.ts";
import { baseName, formatBytes } from "./files/model.ts";
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

/**
 * How much of the thaw is left, for a row that's waiting on one. Null for every other state: a transfer
 * that's downloading, saved, stopped or unpaid has no thaw to count down, and nothing here should invent
 * one for it.
 *
 * Past the estimate we say so rather than showing a clock at zero or running it negative. A bulk retrieval
 * that overruns ~48 hours is normal and not a fault, so the copy has to hold "still fine, still waiting"
 * without either alarming anyone or pretending the estimate still stands.
 */
export const remaining = (r: RestoreRow, now: number): string | null => {
  if (r.state !== "pending") return null;
  const left = r.requestedAt + r.typicalWaitSeconds - now;
  if (left <= 0) return `Taking longer than the usual ${r.typicalWait}. Still waiting.`;
  return timeLeftSentence(left) || null;
};

/** How each state reads to the user. `pending` says what's actually happening (deep storage is waking up)
 * rather than "downloading", which described work that had not started and would not for two days. */
const STATE: Record<RestoreState, { label: string; tone: Tone; icon: string }> = {
  needsAuthorization: { label: "Needs payment", tone: "warning", icon: "credit_card" },
  pending: { label: "Waiting on deep storage", tone: "warning", icon: "hourglass_top" },
  transferring: { label: "Transferring", tone: "accent", icon: "arrow_circle_down" },
  saved: { label: "Saved", tone: "success", icon: "download_done" },
  canceled: { label: "Stopped", tone: "neutral", icon: "cancel" },
  failed: { label: "Didn't finish", tone: "danger", icon: "error" },
};

/** Date + time — a transfer is a same-week thing, so the hour is the useful part. */
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
 * The transferring row's readout — "1.2 GB of 50 GB · 42 MB/s · About 20 minutes left" — from its live
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

/** The bar + readout under a `transferring` row. Indeterminate until the first frame's tick arrives
 * (just flipped, or the app just opened mid-transfer — the next tick lands within a second). */
const TransferBar = ({ p }: { p: RestoreProgress | undefined }): React.JSX.Element => {
  const fraction = progressFraction(p);
  const line = p ? progressLine(p) : null;
  return (
    <div className="cs-transfer-progress">
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
};

/** The folder a transfer saves into (the destination minus the filename). Guards the no-slash case: with
 * no separator `lastIndexOf` is -1, and `slice(0, -1)` would quietly lop off the last character instead. */
const folderOf = (out: string): string => {
  const cut = out.lastIndexOf("/");
  return cut > 0 ? out.slice(0, cut) : "/";
};

/** The one-line explanation under each row. Only says something when there IS something to say — a
 * transferring row that's behaving needs no commentary. */
const detail = (r: RestoreRow): string | null => {
  // An error on a row that's still ACTIVE means a transient fault the daemon is retrying (a network blip
  // during the thaw, say). Say so: the transfer is fine and still going, but a silent hiccup that leaves
  // the page reading "waiting on deep storage" for an extra hour with no explanation is the sort of
  // invisible work the user deserves to see (CORE9).
  if (r.error && isActiveRestore(r.state)) return `Hit a snag (${r.error}) — still trying.`;

  switch (r.state) {
    case "pending":
      // No longer restates the ~48 hours — the countdown above the note says where in it we are, which is
      // the more useful half of the same fact.
      return "You can close the app — this keeps going.";
    case "needsAuthorization":
      return "This one isn't paid for, so deep storage won't release it. Ask for the file again to get a new price.";
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

const Row = ({
  r,
  now,
  progress,
  onStop,
  onResume,
  onForget,
  onReveal,
  onRequestAgain,
}: {
  r: RestoreRow;
  /** Ticking clock from the page, so every row's countdown moves off one interval rather than N. */
  now: number;
  /** This row's live download progress — present only while it's `transferring` (the reducer prunes it
   * the moment the row's state moves on). */
  progress: RestoreProgress | undefined;
  onStop: (r: RestoreRow) => void;
  onResume: (r: RestoreRow) => void;
  onForget: (r: RestoreRow) => void;
  onReveal: (r: RestoreRow) => void;
  onRequestAgain: (r: RestoreRow) => void;
}): React.JSX.Element => {
  const s = STATE[r.state];
  const note = detail(r);
  const left = remaining(r, now);
  return (
    <div className="cs-transfer">
      <span className={`cs-transfer-icon cs-transfer-icon--${s.tone}`}>
        <Icon name={s.icon} size={20} />
      </span>
      <div className="cs-transfer-main">
        <div className="cs-transfer-head">
          <span className="cs-transfer-name" title={r.relativePath}>
            {baseName(r.relativePath)}
          </span>
          <Badge tone={s.tone}>{s.label}</Badge>
        </div>
        <div className="cs-transfer-meta">
          {formatBytes(r.bytes)} · asked {when(r.requestedAt)}
          {r.state === "saved" && r.completedAt ? ` · saved ${when(r.completedAt)}` : ""}
        </div>
        {/* The headline fact for a waiting transfer, so it reads above the standing explanation rather
            than buried inside it. */}
        {left && (
          <div className="cs-transfer-eta">
            <Icon name="schedule" size={16} />
            {left}
          </div>
        )}
        {r.state === "transferring" && <TransferBar p={progress} />}
        {note && <div className="cs-transfer-note">{note}</div>}
      </div>
      <div className="cs-transfer-actions">
        {r.state === "saved" && (
          <Button variant="secondary" size="sm" icon="folder_open" onClick={() => onReveal(r)}>
            Show in Finder
          </Button>
        )}
        {r.state === "needsAuthorization" && (
          <Button variant="secondary" size="sm" icon="refresh" onClick={() => onRequestAgain(r)}>
            Ask again
          </Button>
        )}
        {(r.state === "canceled" || r.state === "failed") && r.resumable && (
          <Button variant="secondary" size="sm" icon="play_arrow" onClick={() => onResume(r)}>
            Pick back up
          </Button>
        )}
        {r.state === "failed" && !r.resumable && (
          <Button variant="secondary" size="sm" icon="refresh" onClick={() => onRequestAgain(r)}>
            Ask again
          </Button>
        )}
        {isActiveRestore(r.state) ? (
          <Button variant="ghost" size="sm" onClick={() => onStop(r)}>
            Stop
          </Button>
        ) : (
          <Button variant="ghost" size="sm" onClick={() => onForget(r)}>
            Remove
          </Button>
        )}
      </div>
    </div>
  );
};

export const TransfersView = ({
  api,
  exec,
  restores,
  restoreProgress,
  onRequestAgain,
}: {
  api: ColdstoreApi;
  exec: Exec;
  restores: readonly RestoreRow[];
  /** Live download progress by row id (the store's `restoreProgress` slice) — feeds each transferring
   * row's bar. */
  restoreProgress: Record<string, RestoreProgress>;
  /** Send the user back to My Files with the request-a-copy dialog open for this file — the way out of
   * `needsAuthorization` (and of a transfer whose thaw window closed), both of which need a fresh price. */
  onRequestAgain: (fileId: string) => void;
}): React.JSX.Element => {
  // The transfer awaiting a stop confirmation. Stopping is worth a confirm because it can't be undone for
  // free once the thaw window closes, and because the money question needs answering before, not after.
  const [stopping, setStopping] = useState<RestoreRow | null>(null);
  const now = useNow();

  const active = restores.filter((r) => isActiveRestore(r.state));
  const past = restores.filter((r) => !isActiveRestore(r.state));

  const rowProps = {
    onStop: setStopping,
    onResume: (r: RestoreRow) => exec(() => api.request("resumeRestore", { id: r.id })),
    onForget: (r: RestoreRow) => exec(() => api.request("forgetRestore", { id: r.id })),
    onReveal: (r: RestoreRow) => void api.revealInFinder(r.out),
    onRequestAgain: (r: RestoreRow) => onRequestAgain(r.fileId),
  };

  const confirmStop = (): void => {
    const r = stopping;
    setStopping(null);
    if (r) exec(() => api.request("cancelRestore", { id: r.id }));
  };

  return (
    <Page title="Transfers">
      {restores.length === 0 ? (
        <EmptyState
          icon="download"
          title="No transfers yet"
          description="When you ask for a copy of something back, it shows up here while it's on its way."
        />
      ) : (
        <>
          {active.length > 0 && (
            <section className="cs-transfers-group">
              <h2 className="cs-transfers-heading">In progress</h2>
              {active.map((r) => (
                <Row key={r.id} r={r} now={now} progress={restoreProgress[r.id]} {...rowProps} />
              ))}
            </section>
          )}
          {past.length > 0 && (
            <section className="cs-transfers-group">
              <h2 className="cs-transfers-heading">Earlier</h2>
              {past.map((r) => (
                <Row key={r.id} r={r} now={now} progress={undefined} {...rowProps} />
              ))}
            </section>
          )}
        </>
      )}

      {stopping && (
        <Modal
          title="Stop this transfer?"
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
              afterwards would be the dishonest version of this dialog. */}
          {stopping.state === "needsAuthorization" ? (
            <p>Nothing has been paid for this one, so stopping it costs you nothing.</p>
          ) : (
            <>
              <p>
                Deep storage is already waking {baseName(stopping.relativePath)} up, and we can&apos;t call
                that back — so stopping won&apos;t refund what it cost.
              </p>
              <p>
                Your copy stays ready for 5 days from when it finishes thawing. Picking it back up in that
                window is free.
              </p>
            </>
          )}
        </Modal>
      )}
    </Page>
  );
};
