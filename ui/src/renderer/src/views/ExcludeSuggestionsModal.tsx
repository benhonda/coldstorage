/**
 * The **Suggested skips** browser — the Settings half of the opt-in exclude packs
 * ({@link ExcludeSuggestion}), behind a dialog rather than dumped into the page.
 *
 * It lives in a modal because of its own length, not to hide it. Five packs, each showing every pattern
 * it would add, is most of a screen — and that bulk sat directly under "Don't back up", where it made a
 * list of *offers* look longer and louder than the list of excludes actually in force. Those chips stay in
 * plain sight on the page, which is the rule that matters: what ISN'T being backed up is never behind a
 * disclosure. What we merely RECOMMEND can be, and the Settings row that opens this says how many are on.
 *
 * Inside, every pattern is visible before anything is added — nobody can consent to a list they can't see.
 * Both directions are here too: a pack is turned on and off from the same row, because "undo that" can't
 * mean deleting seventeen chips one at a time.
 */
import type { ExcludeSuggestion } from "../../../shared/ipc.ts";
import { missingPatterns, packState, presentPatterns } from "../state/excludeSuggestions.ts";
import { Badge, Button, Chip, Modal } from "../ui/primitives.tsx";

/** One suggested pack: what it is, why it's usually safe to skip, exactly what it would add, and the two
 *  gestures that turn it on and off. */
const SuggestionRow = ({
  pack,
  excludes,
  onAdd,
  onRemove,
}: {
  pack: ExcludeSuggestion;
  excludes: string[];
  onAdd: (patterns: string[]) => void;
  onRemove: (patterns: string[]) => void;
}): React.JSX.Element => {
  const state = packState(pack, excludes);
  const missing = missingPatterns(pack, excludes);
  const present = presentPatterns(pack, excludes);
  return (
    <div className="cs-suggestion">
      <div className="cs-suggestion-head">
        <div className="cs-stack-tight">
          <strong>{pack.title}</strong>
          <p className="cs-muted">{pack.detail}</p>
        </div>
        <div className="cs-cluster">
          {state === "on" && (
            <Badge tone="success" icon="check">
              Skipping
            </Badge>
          )}
          {state !== "on" && (
            <Button size="sm" icon="block" onClick={() => onAdd(missing)}>
              {/* "Partial" is a real state — the user turned this on and then deleted a chip. Say what's
                  actually left rather than re-offering the whole pack as though nothing had happened. */}
              {state === "partial" ? `Add the rest (${missing.length})` : "Skip these"}
            </Button>
          )}
          {state !== "off" && (
            <Button size="sm" variant="ghost" onClick={() => onRemove(present)}>
              Stop skipping
            </Button>
          )}
        </div>
      </div>
      <div className="cs-chips">
        {pack.patterns.map((p) => (
          <Chip key={p} mono>
            {p}
          </Chip>
        ))}
      </div>
    </div>
  );
};

export const ExcludeSuggestionsModal = ({
  suggestions,
  excludes,
  onAdd,
  onRemove,
  onClose,
}: {
  suggestions: ExcludeSuggestion[];
  excludes: string[];
  onAdd: (patterns: string[]) => void;
  onRemove: (patterns: string[]) => void;
  onClose: () => void;
}): React.JSX.Element => (
  <Modal
    title="Suggested skips"
    icon="filter_alt"
    onClose={onClose}
    footer={
      <Button variant="primary" onClick={onClose}>
        Done
      </Button>
    }
  >
    <div className="cs-quote">
      <p className="cs-quote-lead">
        Big, regenerable stuff most people don't need a copy of. Nothing here is on until you turn it on,
        and anything you add shows up as a chip you can remove one by one.
      </p>
      <div className="cs-suggestions">
        {suggestions.map((pack) => (
          <SuggestionRow key={pack.id} pack={pack} excludes={excludes} onAdd={onAdd} onRemove={onRemove} />
        ))}
      </div>
    </div>
  </Modal>
);
