/**
 * Auto-update affordance. A quiet top banner shown only when a newer *signed* build has
 * finished downloading in the background (`update.state === "ready"`). It's an offer, not an alarm — the
 * update installs on the next quit regardless; this just lets the user apply it now. Checking/downloading
 * stay invisible (background, non-blocking), matching the calm, no-urgency voice.
 *
 * **Dismissable, because an offer you can't decline is a nag.** Nothing is lost by closing it: the update
 * still installs on quit, and Settings' {@link VersionFooter} keeps saying so for as long as it's true —
 * that footer, not this banner, is where the update machinery is permanently visible (PILLAR5). Dismissal
 * is per VERSION, so a newer build that lands later gets to ask once too, and it deliberately doesn't
 * persist across launches: quitting is what applies the update, so there's nothing left to re-nag about.
 */
import { useState } from "react";
import type { UpdateStatus } from "../../../shared/ipc.ts";
import { Icon, IconButton } from "../ui/primitives.tsx";

interface Props {
  update: UpdateStatus;
  onRestart: () => void;
}

export const UpdateBanner = ({ update, onRestart }: Props): React.JSX.Element | null => {
  // Keyed by the version it was dismissed FOR, not a bare boolean — see the note above.
  const [dismissed, setDismissed] = useState<string | null>(null);

  if (update.state !== "ready") return null;
  // An unversioned "ready" still gets one key of its own, so dismissing it sticks for this session.
  const key = update.version ?? "unknown";
  if (dismissed === key) return null;

  const label = update.version ? `Version ${update.version}` : "A new version";
  return (
    <div className="cs-update" role="status">
      <Icon name="download_done" size={18} />
      <span className="cs-update-msg">{label} of ColdStorage is ready.</span>
      <button type="button" className="cs-update-action" onClick={onRestart}>
        Restart to update
      </button>
      <IconButton icon="close" label="Dismiss" className="cs-update-x" onClick={() => setDismissed(key)} />
    </div>
  );
};
