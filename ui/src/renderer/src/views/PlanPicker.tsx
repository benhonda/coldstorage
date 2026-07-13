/**
 * The size plan picker (PADDLE.md "Multi-plan picker" UX) — shared by the paywall's
 * SubscribeModal and the account card's ChangePlanModal so the two can never drift. Renders the
 * size cards (annual rate) and the live price line; selection state lives here, reported up
 * through `onSelect`. No term selector — every plan is annual (SPEC.md §5, decided 2026-07-12).
 */
import { useEffect, useState } from "react";
import type { CatalogPlan } from "../../../shared/ipc.ts";

const DEFAULT_SIZE = "1 TB";

export const usd = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

export const PlanPicker = ({
  plans,
  initial,
  onSelect,
}: {
  plans: CatalogPlan[];
  /** Seed the selection (e.g. the CURRENT plan when changing) — defaults to 1 TB. */
  initial?: { size: string } | null;
  onSelect: (plan: CatalogPlan | undefined) => void;
}): React.JSX.Element => {
  const [size, setSize] = useState<string>(initial?.size ?? DEFAULT_SIZE);

  // Snap to reality if the seeded size isn't in the catalog (e.g. a legacy plan).
  useEffect(() => {
    const first = plans[0];
    if (first && !plans.some((p) => p.size === size)) setSize(first.size);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- snap once per catalog change
  }, [plans]);

  const current = plans.find((p) => p.size === size);

  useEffect(() => onSelect(current), [current, onSelect]);

  return (
    <>
      <div className="cs-plans" role="radiogroup" aria-label="Storage size">
        {plans.map((p) => (
          <button
            key={p.size}
            type="button"
            role="radio"
            aria-checked={p.size === size}
            className={p.size === size ? "cs-plan cs-plan--active" : "cs-plan"}
            onClick={() => setSize(p.size)}
          >
            <span className="cs-plan-size">{p.size}</span>
            <span className="cs-plan-rate">{usd(p.amountCents)}/yr</span>
          </button>
        ))}
      </div>

      {current && (
        <p className="cs-plan-price">
          <strong>{usd(current.amountCents)}</strong> per year · {usd(current.perMonthCents)}/mo
        </p>
      )}
    </>
  );
};
