/**
 * Deposit collision prompt — the Finder/remote-SSD answer to "you dropped files into a folder that already
 * has some of those names." No silent de-duping: the user decides, per file, whether to **Keep Both**
 * (archive a renamed copy), **Replace** (overwrite the existing one), or **Skip** (don't upload it). An
 * "Apply to all" row sets every file at once for the common case. Defaults to Keep Both — the choice that
 * never loses data.
 *
 * Resolves to a `{ relativePath → policy }` map the caller folds into the `deposit`/`depositPhotos`
 * `conflicts` param; the daemon's {@link CollisionResolvingSource} applies it authoritatively.
 */
import { useState } from "react";
import type { ConflictPolicy } from "../../../../shared/ipc.ts";
import { baseName } from "./model.ts";
import { Button, Modal } from "../../ui/primitives.tsx";

const POLICIES: { value: ConflictPolicy; label: string }[] = [
  { value: "keepBoth", label: "Keep Both" },
  { value: "replace", label: "Replace" },
  { value: "skip", label: "Skip" },
];

/** Three-way segmented control for one file's resolution. */
const PolicyPicker = ({
  value,
  onChange,
  ariaLabel,
}: {
  /** The active policy, or null to show none active (a mixed "apply to all"). */
  value: ConflictPolicy | null;
  onChange: (p: ConflictPolicy) => void;
  ariaLabel: string;
}): React.JSX.Element => (
  <div className="cs-seg" role="group" aria-label={ariaLabel}>
    {POLICIES.map((p) => (
      <button
        key={p.value}
        type="button"
        className={["cs-seg-opt", value === p.value ? "cs-seg-opt--active" : ""].filter(Boolean).join(" ")}
        aria-pressed={value === p.value}
        onClick={() => onChange(p.value)}
      >
        {p.label}
      </button>
    ))}
  </div>
);

export const CollisionModal = ({
  folderName,
  collisions,
  onConfirm,
  onClose,
}: {
  /** Display name of the folder being dropped into ("" → "the top level"). */
  folderName: string;
  /** Vault relativePaths that already exist — one row each. */
  collisions: string[];
  /** Resolve: hand back the per-path policy map. */
  onConfirm: (policies: Record<string, ConflictPolicy>) => void;
  onClose: () => void;
}): React.JSX.Element => {
  // Default every collision to Keep Both — never silently lose a file.
  const [policies, setPolicies] = useState<Record<string, ConflictPolicy>>(() =>
    Object.fromEntries(collisions.map((c) => [c, "keepBoth" as ConflictPolicy])),
  );

  const setOne = (path: string, p: ConflictPolicy): void => setPolicies((prev) => ({ ...prev, [path]: p }));
  const setAll = (p: ConflictPolicy): void =>
    setPolicies(Object.fromEntries(collisions.map((c) => [c, p])));

  const n = collisions.length;
  const where = folderName ? `“${folderName}”` : "the top level";
  // The shared choice for "Apply to all" — the common policy when every row agrees, else null (none lit).
  const first = collisions[0];
  const allValue: ConflictPolicy | null =
    first !== undefined && collisions.every((c) => policies[c] === policies[first]) ? policies[first] ?? null : null;

  return (
    <Modal
      title={n > 1 ? `${n} items already exist` : "1 item already exists"}
      icon="rule"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => onConfirm(policies)}>
            Continue
          </Button>
        </>
      }
    >
      <div className="cs-quote">
        <p className="cs-quote-lead">
          {n > 1 ? "These items" : "This item"} already exist in {where}. Choose what to do with{" "}
          {n > 1 ? "each" : "it"}.
        </p>

        {n > 1 && (
          <div className="cs-collision-all">
            <span className="cs-collision-all-label">Apply to all</span>
            <PolicyPicker value={allValue} onChange={setAll} ariaLabel="Apply one choice to all items" />
          </div>
        )}

        <ul className="cs-collision-list">
          {collisions.map((path) => (
            <li key={path} className="cs-collision-row">
              <span className="cs-collision-name" title={path}>
                {baseName(path)}
              </span>
              <PolicyPicker
                value={policies[path] ?? "keepBoth"}
                onChange={(p) => setOne(path, p)}
                ariaLabel={`What to do with ${baseName(path)}`}
              />
            </li>
          ))}
        </ul>

        <p className="cs-note">
          Keep Both saves the new file under a numbered name. Replace overwrites the copy already here. Skip
          leaves it out. Copies count toward your storage.
        </p>
      </div>
    </Modal>
  );
};
