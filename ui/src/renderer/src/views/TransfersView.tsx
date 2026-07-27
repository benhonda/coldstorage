/**
 * **Transfers** — every copy this Mac has asked for, active and past.
 *
 * This page exists because a transfer is a days-long thing with money attached, and it used to have
 * nowhere to live: the only sign of one was a count in the sidebar foot and a popover listing files, both
 * built from renderer memory. Sign out, or quit the app, and an in-flight transfer someone had paid for
 * simply disappeared. Now the daemon's journal owns them and this page reads the list.
 *
 * The states are named, never a percentage. Deep Archive tells us "warming" or "ready" and nothing in
 * between, so a progress bar would be invented — and, more to the point, for the ~48 hours of a thaw
 * there is no progress to draw, because nothing is moving yet. That's `pending`. `transferring` is
 * reserved for when bytes actually are.
 *
 * What a waiting row CAN honestly say is how much of the wait is left, and that's the one thing someone
 * actually wants from this page. The daemon hands over `typicalWaitSeconds` alongside the prose
 * `typicalWait`, both from the tier it quoted at, so the countdown here is the backend's own estimate
 * ticking down rather than a number the renderer made up.
 */
import { useEffect, useState } from "react";
import type { ColdstoreApi, RestoreRow, RestoreState } from "../../../shared/ipc.ts";
import { isActiveRestore } from "../../../shared/ipc.ts";
import { Badge, Button, EmptyState, Icon, Modal } from "../ui/primitives.tsx";
import { Page } from "../ui/layout.tsx";
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

/** "1 day 17 hours" / "17 hours" / "12 minutes". Coarse on purpose — the underlying figure is AWS's
 * typical case, so a to-the-second readout would dress an estimate up as a measurement. */
export const humanDuration = (seconds: number): string => {
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"}`;
  const hours = Math.round(seconds / 3600);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  const d = `${days} day${days === 1 ? "" : "s"}`;
  return rest === 0 ? d : `${d} ${rest} hour${rest === 1 ? "" : "s"}`;
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
  if (left < 60) return "Less than a minute left";
  return `About ${humanDuration(left)} left`;
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
  onStop,
  onResume,
  onForget,
  onReveal,
  onRequestAgain,
}: {
  r: RestoreRow;
  /** Ticking clock from the page, so every row's countdown moves off one interval rather than N. */
  now: number;
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
  onRequestAgain,
}: {
  api: ColdstoreApi;
  exec: Exec;
  restores: readonly RestoreRow[];
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
                <Row key={r.id} r={r} now={now} {...rowProps} />
              ))}
            </section>
          )}
          {past.length > 0 && (
            <section className="cs-transfers-group">
              <h2 className="cs-transfers-heading">Earlier</h2>
              {past.map((r) => (
                <Row key={r.id} r={r} now={now} {...rowProps} />
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
