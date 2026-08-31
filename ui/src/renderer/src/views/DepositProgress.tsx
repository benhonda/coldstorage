import { useEffect, useState } from "react";
import { etaSeconds, throughput, type RunProgress } from "../state/reducer.ts";
import { baseName, formatBytes } from "./files/model.ts";
import { timeLeft } from "../ui/duration.ts";
import { Button } from "../ui/primitives.tsx";

/**
 * The live deposit banner — the answer to "what's happening and how long will it take".
 *
 * It exists because a batched deposit was a black box: many small files become a few big blobs, and the
 * daemon only signalled a file as done when its whole blob verified — so the user saw nothing for minutes,
 * then a burst of green (2026-07-14). The daemon now streams `runProgress`; this renders it.
 *
 * A deposit has a life BEFORE it has a byte count, so there are two banners here, not one:
 *   - {@link PreparingBanner} — accepted, and the daemon is still walking what was dropped. This drew
 *     nothing at all until 2026-08-24: a 30 GB folder sat silent through its whole recursive stat, which
 *     reads exactly like the app ignored you.
 *   - {@link RunBanner} — bytes moving, in one of two modes, because the two kinds of deposit carry
 *     different information: a **byte bar** (files — `bytesTotal` known, so a determinate bar + a real
 *     ETA) or a **count bar** (photos — sizes unknown until streamed, so "N of M files" and an
 *     indeterminate shimmer, never a faked byte count or time estimate).
 *   - {@link StoppedBanner} — the run the user just stopped, and what it left behind. There was no way to
 *     stop an upload at all until 2026-08-24 ("cancel" meant quitting the app), so this is the whole
 *     answer to "what did pressing Stop do?": nothing already stored is undone, and here's how many
 *     files still aren't.
 */
export function DepositProgress({
  run,
  preparing,
  paused,
  onStop,
  onResume,
}: {
  run: RunProgress | null;
  /** What a just-accepted drop is being read for (“Videos”), while the daemon resolves where it
   *  lands — the window before any run exists. Null when nothing is being read. */
  preparing?: string | null;
  /** The daemon-level upload pause (`Status.uploadsPaused`, PAUSE.md). While true, the run banner is
   *  replaced by {@link PausedBanner}: a parked run streams no progress, and a frozen "Uploading…" bar
   *  reads as stalled — the one thing pause must never look like. */
  paused: boolean;
  /** Stop the run in flight (the daemon's `cancelRun`, through the view's `exec`, which owns the error
   *  toast). Firing it is not the run stopping — that arrives as `runFinished`; "Stopping…" covers the gap. */
  onStop: () => void;
  /** `resumeUploads`, through the view's `exec`. The banner leaves when `uploadsPausedChanged` folds the
   *  new state into the status snapshot — "Resuming…" covers the gap. */
  onResume: () => void;
}): React.JSX.Element {
  // Two INDEPENDENT facts, so two banners, not a winner: a drop can be read while an earlier one is still
  // uploading, and neither state may hide the other. Pause replaces only the RUN banner — a drop still
  // being read keeps its own state (the daemon will refuse the deposit with its own words if it lands
  // while paused, and that toast beats a silently vanished banner).
  return (
    <>
      {preparing && <PreparingBanner what={preparing} />}
      {paused ? <PausedBanner onResume={onResume} /> : <RunBanner run={run} onStop={onStop} />}
      <StoppedBanner run={run} />
    </>
  );
}

/** Uploads are paused — a persistent state, not a moment, so it stays until the user resumes (here, or in
 *  Settings). Calm on purpose: paused is something the user chose, not something wrong. */
function PausedBanner({ onResume }: { onResume: () => void }): React.JSX.Element {
  // Honest pending state (PILLAR5), same shape as Stop: the command acks instantly but the banner only
  // leaves when the daemon's `uploadsPausedChanged` flips the snapshot — "Resuming…" covers that gap.
  // No reset effect needed: the whole banner unmounts when `paused` flips.
  const [resuming, setResuming] = useState(false);
  const resume = (): void => {
    setResuming(true);
    onResume();
  };
  return (
    <div className="cs-deposit" role="status" aria-live="polite">
      <div className="cs-deposit-head">
        <span className="cs-deposit-title">Uploads paused</span>
        <Button variant="ghost" size="sm" onClick={resume} disabled={resuming}>
          {resuming ? "Resuming…" : "Resume"}
        </Button>
      </div>
      <div className="cs-bar-meta">
        Nothing is using your connection. Everything already stored is safe, and backing up picks up right
        where it left off when you resume.
      </div>
    </div>
  );
}

/** What a Stop left behind — shown from `runFinished` until the next run starts or it's dismissed. */
function StoppedBanner({ run }: { run: RunProgress | null }): React.JSX.Element | null {
  const stopped = run && !run.active ? (run.filesStopped ?? 0) : 0;
  const [dismissed, setDismissed] = useState(false);
  // A NEW stop (a different count, or a fresh run) un-dismisses; an unchanged one stays dismissed.
  useEffect(() => setDismissed(false), [stopped, run?.active]);
  if (stopped === 0 || dismissed) return null;
  return (
    <div className="cs-deposit" role="status" aria-live="polite">
      <div className="cs-deposit-head">
        <span className="cs-deposit-title">Stopped</span>
        <Button variant="ghost" size="sm" onClick={() => setDismissed(true)}>
          OK
        </Button>
      </div>
      <div className="cs-bar-meta">
        {stopped === 1 ? "1 file wasn't" : `${stopped} files weren't`} uploaded. What was already stored is
        safe. Drop them again, or a watched folder picks them up on its next pass.
      </div>
    </div>
  );
}

/** A drop the daemon is still reading — accepted, walking, nothing to count yet. */
function PreparingBanner({ what }: { what: string }): React.JSX.Element {
  return (
    <div className="cs-deposit" role="status" aria-live="polite">
      <div className="cs-deposit-head">
        <span className="cs-deposit-title">Reading {what}…</span>
      </div>
      <div className="cs-bar-track cs-bar-track--indeterminate" role="progressbar">
        <div className="cs-bar-fill" />
      </div>
      <div className="cs-bar-meta">Working out what to upload</div>
    </div>
  );
}

/** The live run — bytes actually moving. */
function RunBanner({ run, onStop }: { run: RunProgress | null; onStop: () => void }): React.JSX.Element | null {
  // Honest pending state for Stop (PILLAR5): the command acks instantly but the daemon stops between
  // frames, and `runFinished` is what actually ends the banner. "Stopping…" + disabled covers that gap so
  // a second click can't fire and the button doesn't just sit there looking ignored. Reset when the run
  // ends (`runStarted` replaces the run record; `active` false returns null below). A rejected command
  // (daemon gone) is toasted by the view's `exec` — and a gone daemon ends the banner anyway.
  const [stopping, setStopping] = useState(false);
  useEffect(() => setStopping(false), [run?.active]);
  const stop = (): void => {
    setStopping(true);
    onStop();
  };

  // Show ONLY while something is actually being uploaded — not merely because a run is `active`. A periodic
  // scan of an already-archived vault runs (active=true) and reports the whole vault as `filesTotal`, but
  // does no work: no file streams, no bytes ship. Gating on real activity (a current file, or bytes moving)
  // keeps the banner from flashing "0 of N files" every scan interval; a real deposit sets `currentPath` on
  // its first item, so it appears promptly.
  if (!run?.active || (!run.currentPath && run.bytesUploaded === 0)) return null;

  const { filesArchived, filesTotal, bytesUploaded, bytesTotal, currentPath, samples } = run;
  const knowBytes = bytesTotal != null && bytesTotal > 0;
  const fraction = knowBytes ? Math.min(1, bytesUploaded / bytesTotal) : null;
  const rate = throughput(samples);
  const eta = etaSeconds(samples, bytesUploaded, bytesTotal);

  // "Preparing" = the banner is up (a file has started) but not one ciphertext byte has shipped yet. The
  // daemon only counts bytes when a whole 64 MiB part lands, so there's a real gap at the start where a
  // determinate "0 B of 4.2 GB · 0%" bar would just sit there looking dead. Show an honest working state
  // instead — an indeterminate shimmer + "Preparing…" — until the first part gives us something true to show.
  const beforeFirstPart = bytesUploaded === 0;
  const indeterminate = beforeFirstPart || fraction == null;

  // The one-line summary. Only state what we actually know — no invented precision.
  const parts: string[] = [];
  if (beforeFirstPart) {
    parts.push("Preparing…");
  } else {
    if (filesTotal != null) parts.push(`${Math.min(filesArchived, filesTotal)} of ${filesTotal} files`);
    else if (filesArchived > 0) parts.push(`${filesArchived} files`);
    if (knowBytes) parts.push(`${formatBytes(bytesUploaded)} of ${formatBytes(bytesTotal)}`);
    if (rate != null) parts.push(`${formatBytes(rate)}/s`);
    const eta_ = eta != null ? timeLeft(eta) : "";
    if (eta_) parts.push(eta_);
  }

  return (
    <div className="cs-deposit" role="status" aria-live="polite">
      <div className="cs-deposit-head">
        <span className="cs-deposit-title">
          {stopping ? "Stopping…" : currentPath ? `Uploading ${baseName(currentPath)}` : "Uploading…"}
        </span>
        <span className="cs-deposit-side">
          {!indeterminate && fraction != null && (
            <span className="cs-deposit-pct">{Math.round(fraction * 100)}%</span>
          )}
          <Button variant="ghost" size="sm" onClick={stop} disabled={stopping}>
            {stopping ? "Stopping…" : "Stop"}
          </Button>
        </span>
      </div>

      <div
        className={`cs-bar-track${indeterminate ? " cs-bar-track--indeterminate" : ""}`}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={indeterminate ? undefined : 100}
        aria-valuenow={indeterminate || fraction == null ? undefined : Math.round(fraction * 100)}
      >
        <div
          className="cs-bar-fill"
          style={indeterminate || fraction == null ? undefined : { width: `${fraction * 100}%` }}
        />
      </div>

      {parts.length > 0 && <div className="cs-bar-meta">{parts.join(" · ")}</div>}
    </div>
  );
}

// `etaLabel` used to live here. It's now `ui/duration.ts`'s `timeLeft`, shared with the Downloads page's
// thaw countdown — same question, same input, and keeping two of them meant two voices for one fact.
