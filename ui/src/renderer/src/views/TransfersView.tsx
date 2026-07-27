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
 */
import { useState } from "react";
import type { ColdstoreApi, RestoreRow, RestoreState } from "../../../shared/ipc.ts";
import { isActiveRestore } from "../../../shared/ipc.ts";
import { Badge, Button, EmptyState, Icon, Modal } from "../ui/primitives.tsx";
import { Page } from "../ui/layout.tsx";
import { baseName, formatBytes } from "./files/model.ts";
import type { Exec } from "./types.ts";

type Tone = "neutral" | "accent" | "warning" | "success" | "danger";

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
      return `Deep storage usually takes ${r.typicalWait} to wake a file up. You can close the app — this keeps going.`;
    case "needsAuthorization":
      return "This one isn't paid for, so deep storage won't release it. Ask for the file again to get a new price.";
    case "transferring":
      return null;
    case "saved":
      return `Saved to ${folderOf(r.out)}`;
    case "canceled":
      return r.resumable
        ? "You stopped this. The copy is still warm, so picking it back up costs nothing."
        : "You stopped this. Asking again will be a new request.";
    case "failed":
      return r.error ?? "Something went wrong.";
  }
};

const Row = ({
  r,
  onStop,
  onResume,
  onForget,
  onReveal,
  onRequestAgain,
}: {
  r: RestoreRow;
  onStop: (r: RestoreRow) => void;
  onResume: (r: RestoreRow) => void;
  onForget: (r: RestoreRow) => void;
  onReveal: (r: RestoreRow) => void;
  onRequestAgain: (r: RestoreRow) => void;
}): React.JSX.Element => {
  const s = STATE[r.state];
  const note = detail(r);
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
                <Row key={r.id} r={r} {...rowProps} />
              ))}
            </section>
          )}
          {past.length > 0 && (
            <section className="cs-transfers-group">
              <h2 className="cs-transfers-heading">Earlier</h2>
              {past.map((r) => (
                <Row key={r.id} r={r} {...rowProps} />
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
