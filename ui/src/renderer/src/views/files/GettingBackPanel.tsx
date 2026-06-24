/**
 * The "getting back" queue — a popover off the sidebar indicator listing every in-flight restore with
 * its named stage and quoted ready-by. Deep Archive reports only "warming" vs "ready" (no %), so the
 * stages are named, never a fake progress bar. Closes on outside click or Escape.
 */
import { useEffect } from "react";
import { createPortal } from "react-dom";
import type { RestoreActivity } from "../../state/reducer.ts";
import type { ArchivedFile } from "./model.ts";
import { baseName, formatDate } from "./model.ts";
import { Icon } from "../../ui/primitives.tsx";

/** Named download stages — mapped from the daemon's restore* state (no percentages exist to show). */
const STAGE: Record<RestoreActivity["state"], string> = {
  requested: "Preparing",
  inProgress: "Downloading",
  completed: "Ready",
};

export const GettingBackPanel = ({
  files,
  restores,
  onClose,
}: {
  files: ArchivedFile[];
  restores: Record<string, RestoreActivity>;
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
    <div className="cs-queue" onClick={(e) => e.stopPropagation()}>
      <div className="cs-queue-head">Transferring</div>
      {files.map((f) => {
        const stage = STAGE[restores[f.id]?.state ?? "requested"];
        return (
          <div className="cs-queue-row" key={f.id}>
            <Icon name="hourglass_top" size={18} />
            <div className="cs-queue-main">
              <div className="cs-queue-name">{baseName(f.relativePath)}</div>
              <div className="cs-queue-sub">
                {stage}
                {f.readyBy ? ` · ready ${formatDate(f.readyBy)}` : ""}
              </div>
            </div>
          </div>
        );
      })}
    </div>,
    document.body,
  );
};
