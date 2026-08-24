/**
 * The drop-time suggested-skips prompt — the moment this whole feature exists for.
 *
 * A deposit preview walks the dropped folder and the daemon tags every file that one of its opt-in packs
 * ({@link ExcludeSuggestion}) would have skipped. When that adds up to something worth a person's
 * attention ({@link worthPrompting}), we stop the drop here and say what we found, in files and bytes,
 * before a single one is uploaded. Deep Archive bills a 180-day minimum on everything that lands, so this
 * is the last moment the answer is free.
 *
 * Three rules this prompt is built on:
 *  - **No default that can be blown through.** There is no pre-selected "just hit Continue" path that
 *    quietly drops files from a backup. Skipping and keeping are two labelled buttons, and the user picks.
 *  - **Skipping is for this drop only** — it rides along as the deposit's `excludeExtra` and is then
 *    forgotten. "Not this time" and "never again" are different answers.
 *  - **"Never again" is opt-in and unchecked**, because it edits a setting that governs every future
 *    upload. The user asked to skip these files; they didn't ask us to change their configuration.
 */
import { useState } from "react";
import type { DropMatch } from "../../state/excludeSuggestions.ts";
import { formatBytes } from "./model.ts";
import { Button, Modal } from "../../ui/primitives.tsx";

/** What the user decided. `packIds` is what to leave out of THIS deposit; `remember` asks us to add those
 *  packs' patterns to the excludes registry as well. An empty `packIds` means "back it all up". */
export interface SkipDecision {
  packIds: string[];
  remember: boolean;
}

export const SuggestedSkipsModal = ({
  matches,
  folderName,
  onConfirm,
  onClose,
}: {
  /** Per-pack file/byte totals for the pending drop, heaviest first. Never empty. */
  matches: DropMatch[];
  /** Display name of the folder being dropped into ("" → "the top level"). */
  folderName: string;
  onConfirm: (decision: SkipDecision) => void;
  /** Esc / Cancel — abort the whole drop, upload nothing. Same escape as the collision prompt. */
  onClose: () => void;
}): React.JSX.Element => {
  // Every pack starts ticked: these are our recommendations, and the user is here to accept or refuse
  // them. Ticking is not the act — pressing "Skip these" is, and "Back up everything" sits right beside it.
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(matches.map((m) => m.pack.id)));
  const [remember, setRemember] = useState(false);

  const toggle = (id: string): void =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const picked = matches.filter((m) => chosen.has(m.pack.id));
  const bytes = picked.reduce((n, m) => n + m.bytes, 0);
  const files = picked.reduce((n, m) => n + m.files, 0);
  const totalBytes = matches.reduce((n, m) => n + m.bytes, 0);
  const where = folderName ? `“${folderName}”` : "the top level";

  return (
    <Modal
      title="Some of this probably doesn't need backing up"
      icon="filter_alt"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => onConfirm({ packIds: [], remember: false })}>Back up everything</Button>
          <Button variant="primary" disabled={picked.length === 0} onClick={() => onConfirm({ packIds: [...chosen], remember })}>
            {picked.length === 0 ? "Skip these" : `Skip ${formatBytes(bytes)}`}
          </Button>
        </>
      }
    >
      <div className="cs-quote">
        {/* Factual, not salesy — name the junk and the number, don't congratulate anyone (ui/DESIGN.md). */}
        <p className="cs-quote-lead">
          {formatBytes(totalBytes)} of what you're adding to {where} looks like files that come back on
          their own. You can leave them out — everything else uploads either way.
        </p>

        <ul className="cs-skip-list">
          {matches.map((m) => (
            <li key={m.pack.id}>
              <label className="cs-optin">
                <input type="checkbox" checked={chosen.has(m.pack.id)} onChange={() => toggle(m.pack.id)} />
                <span>
                  <strong>{m.pack.title}</strong> — {m.files.toLocaleString()}{" "}
                  {m.files === 1 ? "file" : "files"}, {formatBytes(m.bytes)}
                  <br />
                  {m.pack.detail}
                </span>
              </label>
            </li>
          ))}
        </ul>

        <label className="cs-optin">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.currentTarget.checked)} />
          <span>
            <strong>Remember this.</strong> Skip these everywhere from now on, not just this time. You can
            change it any time in Settings, under Don't back up.
          </span>
        </label>

        <p className="cs-note">
          {files > 0
            ? `${files.toLocaleString()} ${files === 1 ? "file" : "files"} won't be uploaded. Nothing is deleted from your Mac — they just stay off the backup.`
            : "Nothing selected — everything in this drop will be uploaded."}
        </p>
      </div>
    </Modal>
  );
};
