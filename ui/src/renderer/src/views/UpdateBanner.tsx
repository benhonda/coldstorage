/**
 * Auto-update affordance (PROD.md Phase 6). A quiet top banner shown only when a newer *signed* build has
 * finished downloading in the background (`update.state === "ready"`). It's an offer, not an alarm — the
 * update installs on the next quit regardless; this just lets the user apply it now. Checking/downloading
 * stay invisible (background, non-blocking), matching the calm, no-urgency voice.
 *
 * Minimal by design: final wording/placement is a UX-session call (like the footer's failures pill).
 */
import type { UpdateStatus } from "../../../shared/ipc.ts";
import { Icon } from "../ui/primitives.tsx";

interface Props {
  update: UpdateStatus;
  onRestart: () => void;
}

export const UpdateBanner = ({ update, onRestart }: Props): React.JSX.Element | null => {
  if (update.state !== "ready") return null;
  const label = update.version ? `Version ${update.version}` : "A new version";
  return (
    <div className="cs-update" role="status">
      <Icon name="download_done" size={18} />
      <span className="cs-update-msg">{label} of ColdStorage is ready.</span>
      <button type="button" className="cs-update-action" onClick={onRestart}>
        Restart to update
      </button>
    </div>
  );
};
