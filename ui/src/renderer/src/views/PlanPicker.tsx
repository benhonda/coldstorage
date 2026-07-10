/**
 * The size × term plan picker (PADDLE.md "Multi-plan picker" UX) — shared by the paywall's
 * SubscribeModal and the account card's ChangePlanModal so the two can never drift. Renders the
 * three size cards (neutral per-year rates), the term segmented row, the live price line, and the
 * quiet rate-lock note; selection state lives here, reported up through `onSelect`.
 */
import { useEffect, useMemo, useState } from "react";
import type { CatalogPlan } from "../../../shared/ipc.ts";

const DEFAULT_SIZE = "1 TB";
const DEFAULT_YEARS = 1;

export const usd = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

export const PlanPicker = ({
  plans,
  initial,
  onSelect,
}: {
  plans: CatalogPlan[];
  /** Seed the selection (e.g. the CURRENT plan when changing) — defaults to 1 TB · 1yr. */
  initial?: { size: string; years: number } | null;
  onSelect: (plan: CatalogPlan | undefined) => void;
}): React.JSX.Element => {
  const [size, setSize] = useState<string>(initial?.size ?? DEFAULT_SIZE);
  const [years, setYears] = useState<number>(initial?.years ?? DEFAULT_YEARS);

  /** Sizes in catalog order (cheapest first), each with its per-year base rate for the card. */
  const sizes = useMemo(() => {
    const seen = new Map<string, number>();
    for (const p of plans) {
      // The 1-year price IS the yearly rate; derive for safety if a size somehow lacks one.
      if (!seen.has(p.size) || p.years === 1) seen.set(p.size, p.years === 1 ? p.amountCents : Math.round(p.amountCents / p.years));
    }
    return [...seen.entries()].map(([s, perYearCents]) => ({ size: s, perYearCents }));
  }, [plans]);

  // Snap to reality if the seeded size isn't in the catalog (e.g. a legacy plan).
  useEffect(() => {
    const first = plans[0];
    if (first && !plans.some((p) => p.size === size)) setSize(first.size);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- snap once per catalog change
  }, [plans]);

  const terms = useMemo(() => plans.filter((p) => p.size === size).sort((a, b) => a.years - b.years), [plans, size]);
  const current = terms.find((p) => p.years === years) ?? terms[0];

  useEffect(() => onSelect(current), [current, onSelect]);

  return (
    <>
      <div className="cs-plans" role="radiogroup" aria-label="Storage size">
        {sizes.map((s) => (
          <button
            key={s.size}
            type="button"
            role="radio"
            aria-checked={s.size === size}
            className={s.size === size ? "cs-plan cs-plan--active" : "cs-plan"}
            onClick={() => setSize(s.size)}
          >
            <span className="cs-plan-size">{s.size}</span>
            <span className="cs-plan-rate">{usd(s.perYearCents)}/yr</span>
          </button>
        ))}
      </div>

      <div className="cs-plan-terms">
        <div className="cs-seg" role="radiogroup" aria-label="Term length">
          {terms.map((t) => (
            <button
              key={t.years}
              type="button"
              role="radio"
              aria-checked={t.years === current?.years}
              className={t.years === current?.years ? "cs-seg-opt cs-seg-opt--active" : "cs-seg-opt"}
              onClick={() => setYears(t.years)}
            >
              {t.years} yr{t.years > 1 ? "s" : ""}
            </button>
          ))}
        </div>
      </div>

      {current && (
        <>
          <p className="cs-plan-price">
            <strong>{usd(current.amountCents)}</strong>{" "}
            {current.years === 1 ? "per year" : `for ${current.years} years`} · {usd(current.perMonthCents)}/mo
          </p>
          <p className="cs-plan-lock">Longer terms lock today&apos;s rate.</p>
        </>
      )}
    </>
  );
};
