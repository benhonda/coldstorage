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

  // The one-line summary. Only state what we actually know — no invented precision.
  const parts: string[] = [];
  if (filesTotal != null) parts.push(`${Math.min(filesArchived, filesTotal)} of ${filesTotal} files`);
  else if (filesArchived > 0) parts.push(`${filesArchived} files`);
  if (knowBytes) parts.push(`${formatBytes(bytesUploaded)} of ${formatBytes(bytesTotal)}`);
  if (rate != null) parts.push(`${formatBytes(rate)}/s`);
  if (eta != null) parts.push(`about ${formatDuration(eta)} left`);

  return (
    <div className="cs-deposit" role="status" aria-live="polite">
      <div className="cs-deposit-head">
        <span className="cs-deposit-title">
          {currentPath ? `Uploading ${baseName(currentPath)}` : "Uploading…"}
        </span>
        {fraction != null && <span className="cs-deposit-pct">{Math.round(fraction * 100)}%</span>}
      </div>

      <div
        className={`cs-deposit-track${fraction == null ? " cs-deposit-track--indeterminate" : ""}`}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={fraction == null ? undefined : 100}
        aria-valuenow={fraction == null ? undefined : Math.round(fraction * 100)}
      >
        <div
          className="cs-deposit-fill"
          style={fraction == null ? undefined : { width: `${fraction * 100}%` }}
        />
      </div>

      {parts.length > 0 && <div className="cs-deposit-meta">{parts.join(" · ")}</div>}
    </div>
  );
}

/** A rough, human duration for an ETA — coarse on purpose, because the underlying rate wobbles. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s`;
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem === 0 ? `${hours} hr` : `${hours} hr ${rem} min`;
}
