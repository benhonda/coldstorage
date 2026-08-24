import { etaSeconds, throughput, type RunProgress } from "../state/reducer.ts";
import { baseName, formatBytes } from "./files/model.ts";
import { timeLeft } from "../ui/duration.ts";

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
 */
export function DepositProgress({
  run,
  preparing,
}: {
  run: RunProgress | null;
  /** What a just-accepted drop is being read for (“Videos”), while the daemon resolves where it
   *  lands — the window before any run exists. Null when nothing is being read. */
  preparing?: string | null;
}): React.JSX.Element {
  // Two INDEPENDENT facts, so two banners, not a winner: a drop can be read while an earlier one is still
  // uploading, and neither state may hide the other.
  return (
    <>
      {preparing && <PreparingBanner what={preparing} />}
      <RunBanner run={run} />
    </>
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
function RunBanner({ run }: { run: RunProgress | null }): React.JSX.Element | null {
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
          {currentPath ? `Uploading ${baseName(currentPath)}` : "Uploading…"}
        </span>
        {!indeterminate && fraction != null && (
          <span className="cs-deposit-pct">{Math.round(fraction * 100)}%</span>
        )}
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
