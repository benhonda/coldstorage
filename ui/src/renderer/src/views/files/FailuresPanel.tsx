/**
 * The "couldn't upload" popover — off the sidebar indicator, listing uploads that failed PERMANENTLY
 * (the daemon classified them non-retryable and stopped trying). Transient blips never appear here —
 * they stay shown as `uploading` and self-heal (Ben, 2026-06-24). Mirrors {@link GettingBackPanel}.
 * Closes on outside click / Escape. "Try again" re-triggers a run (the daemon re-attempts non-skipped
 * work; a permanent fault that's since been fixed will then clear).
 *
 * COPY IS PLACEHOLDER — Ben gatekeeps the error wording. Today the daemon reports failures per-BLOB, not
 * per-file, and a blob id is meaningless to the user, so each row is a generic line + the raw daemon
 * `message` (muted, for now). Once the daemon persists a per-file `failed` status + names the affected
 * files (see ELECTRON-UI-DESIGN.md "Daemon contract gaps → error handling"), swap the generic line for
 * the file names and drop the raw message behind a "details" affordance.
 */
import { useEffect } from "react";
import { createPortal } from "react-dom";
import type { BlobFailure } from "../../state/reducer.ts";
import { Button, Icon } from "../../ui/primitives.tsx";

export const FailuresPanel = ({
  failures,
  onRetry,
  onClose,
}: {
  failures: BlobFailure[];
  onRetry: () => void;
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
            {/* PLACEHOLDER — becomes the affected file names once the daemon reports them per-file */}
            <div className="cs-queue-name">Some files couldn&apos;t be uploaded</div>
            <div className="cs-queue-sub">{f.message}</div>
          </div>
        </div>
      ))}
      <div className="cs-queue-foot">
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
