/**
 * The "couldn't upload" popover — off the sidebar indicator, listing uploads that failed PERMANENTLY
 * (the daemon classified them non-retryable and stopped trying). Transient blips never appear here —
 * they stay shown as `uploading` and self-heal (Ben, 2026-06-24). Mirrors {@link GettingBackPanel}.
 * Closes on outside click / Escape. "Try again" re-triggers a run (the daemon re-attempts non-skipped
 * work; a permanent fault that's since been fixed will then clear). "Dismiss" acknowledges the failures
 * and clears the pill — the file rows keep their journal-backed ⚠, and a fault the daemon re-hits
 * re-surfaces (see the reducer's `failuresDismissed`).
 *
 * COPY IS PLACEHOLDER — Ben gatekeeps the error wording. The daemon now names the affected files (the
 * `blobFailed` event carries their relativePaths), so each row lists the file name(s) that couldn't upload
 * with the raw daemon `message` muted beneath. (A future "details" affordance can tuck the raw message
 * away once Ben settles the copy.)
 */
import { useEffect } from "react";
import { createPortal } from "react-dom";
import type { BlobFailure } from "../../state/reducer.ts";
import { baseName } from "./model.ts";
import { Button, Icon } from "../../ui/primitives.tsx";

/** Human file list for a failed blob: the file basenames, or a generic line if none were named. */
const failedNames = (paths: string[]): string =>
  paths.length === 0 ? "Some files couldn't be uploaded" : paths.map(baseName).join(", ");

export const FailuresPanel = ({
  failures,
  onRetry,
  onDismiss,
  onClose,
}: {
  failures: BlobFailure[];
  onRetry: () => void;
  /** Acknowledge-and-clear: drops the recorded failures (and so the footer pill) without retrying. */
  onDismiss: () => void;
  onClose: () => void;
}): React.JSX.Element => {
  useEffect(() => {
    const close = (): void => onClose();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return createPortal(
    <div className="cs-queue cs-queue--fail" onClick={(e) => e.stopPropagation()}>
      {/* PLACEHOLDER copy — Ben to finalize */}
      <div className="cs-queue-head">Couldn&apos;t upload</div>
      {failures.map((f) => (
        <div className="cs-queue-row" key={f.blob}>
          <Icon name="error" size={18} />
          <div className="cs-queue-main">
            <div className="cs-queue-name">{failedNames(f.files)}</div>
            <div className="cs-queue-sub">{f.message}</div>
          </div>
        </div>
      ))}
      <div className="cs-queue-foot cs-queue-foot--row">
        {/* PLACEHOLDER copy — Ben to finalize */}
        <Button
          variant="ghost"
          size="sm"
          full
          onClick={() => {
            onDismiss();
            onClose();
          }}
        >
          Dismiss
        </Button>
        <Button
          variant="secondary"
          size="sm"
          icon="refresh"
          full
          onClick={() => {
            onRetry();
            onClose();
          }}
        >
          Try again
        </Button>
      </div>
    </div>,
    document.body,
  );
};
