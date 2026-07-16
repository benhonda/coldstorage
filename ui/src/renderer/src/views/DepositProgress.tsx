import { etaSeconds, throughput, type RunProgress } from "../state/reducer.ts";
import { baseName, formatBytes } from "./files/model.ts";

/**
 * The live deposit banner — the answer to "what's happening and how long will it take".
 *
 * It exists because a batched deposit was a black box: many small files become a few big blobs, and the
 * daemon only signalled a file as done when its whole blob verified — so the user saw nothing for minutes,
 * then a burst of green (2026-07-14). The daemon now streams `runProgress`; this renders it.
 *
 * Two modes, because two kinds of deposit carry different information:
 *   - **byte bar** (files): `bytesTotal` is known, so we show a determinate bar + a real ETA.
 *   - **count bar** (photos): sizes aren't known until streamed, so `bytesTotal` is null — we fall back to
 *     "N of M files" and an indeterminate shimmer, and DON'T fake a byte count or a time estimate.
 */
export function DepositProgress({ run }: { run: RunProgress | null }): React.JSX.Element | null {
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
  const preparing = bytesUploaded === 0;
  const indeterminate = preparing || fraction == null;

  // The one-line summary. Only state what we actually know — no invented precision.
  const parts: string[] = [];
  if (preparing) {
    parts.push("Preparing…");
  } else {
    if (filesTotal != null) parts.push(`${Math.min(filesArchived, filesTotal)} of ${filesTotal} files`);
    else if (filesArchived > 0) parts.push(`${filesArchived} files`);
    if (knowBytes) parts.push(`${formatBytes(bytesUploaded)} of ${formatBytes(bytesTotal)}`);
    if (rate != null) parts.push(`${formatBytes(rate)}/s`);
    const eta_ = eta != null ? etaLabel(eta) : "";
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
        className={`cs-deposit-track${indeterminate ? " cs-deposit-track--indeterminate" : ""}`}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={indeterminate ? undefined : 100}
        aria-valuenow={indeterminate || fraction == null ? undefined : Math.round(fraction * 100)}
      >
        <div
          className="cs-deposit-fill"
          style={indeterminate || fraction == null ? undefined : { width: `${fraction * 100}%` }}
        />
      </div>

      {parts.length > 0 && <div className="cs-deposit-meta">{parts.join(" · ")}</div>}
    </div>
  );
}

/**
 * A coarse, human ETA phrase — e.g. "under a minute left", "about 5 min left", "about 1½ hr left".
 *
 * Coarse ON PURPOSE. The daemon reports bytes per 64 MiB part, so a fresh estimate only lands every
 * part (tens of seconds apart) and the raw rate wobbles between them. Showing exact seconds made the
 * readout lurch to odd values ("43s" → "12s") every time a part landed. Friendly buckets — no seconds,
 * coarser the further out you are — absorb that jitter so the estimate reads as the rough guide it is,
 * not a stopwatch. Returns "" when there's nothing worth saying.
 */
export function etaLabel(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  if (seconds < 60) return "under a minute left";
  const mins = seconds / 60;
  if (mins < 60) {
    // Nearest minute up close, nearest 5 once it's a longer wait — precision matters less the further out.
    const step = mins < 10 ? 1 : 5;
    const rounded = Math.max(1, Math.round(mins / step) * step);
    return `about ${rounded} min left`;
  }
  // Over an hour: round to the nearest half-hour and stop there. Sub-hour precision would only wobble.
  const halfHours = Math.round(mins / 30);
  const hrs = Math.floor(halfHours / 2);
  const half = halfHours % 2 === 1;
  return `about ${hrs}${half ? "½" : ""} hr left`;
}
