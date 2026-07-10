/**
 * Paywall + plan picker (PROD.md Phase 5c · PADDLE.md "Multi-plan picker") — shown when a signed-in
 * user without an active subscription tries to deposit. A soft gate: backing up NEW files needs a
 * subscription, but anything already stored stays restorable (say so — no holding data hostage).
 *
 * The catalog is fetched live from the billing server (sizes × terms, exactly what Paddle will sell) —
 * never hardcoded here. Size is the weighty choice (three cards, neutral per-year rates, no
 * usage-based nudge); term is a segmented row. "Subscribe" opens Paddle checkout in the system
 * browser for the chosen plan; while that's open we poll, and the modal reflects `checkingOut`
 * until the webhook lands.
 */
import { useEffect, useMemo, useState } from "react";
import { Alert, Button, Modal } from "../ui/primitives.tsx";
import type { CatalogPlan, ColdstoreApi, EntitlementStatus } from "../../../shared/ipc.ts";

const DEFAULT_SIZE = "1 TB";
const DEFAULT_YEARS = 1;

const usd = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

export const SubscribeModal = ({
  api,
  entitlement,
  onSubscribe,
  onClose,
}: {
  api: ColdstoreApi;
  entitlement: EntitlementStatus;
  onSubscribe: (priceId: string) => void;
  onClose: () => void;
}): React.JSX.Element => {
  const [plans, setPlans] = useState<CatalogPlan[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [size, setSize] = useState<string>(DEFAULT_SIZE);
  const [years, setYears] = useState<number>(DEFAULT_YEARS);
  const [loadNonce, setLoadNonce] = useState(0); // bump to retry after a failed fetch

  useEffect(() => {
    let alive = true;
    setLoadError(null);
    api
      .getPlanCatalog()
      .then((p) => {
        if (!alive) return;
        setPlans(p);
        // Default-select 1 TB · 1yr (the spec's neutral middle pick) — snap to reality if absent.
        if (!p.some((x) => x.size === DEFAULT_SIZE)) setSize(p[0]?.size ?? DEFAULT_SIZE);
      })
      .catch((e: unknown) => {
        if (alive) setLoadError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [api, loadNonce]);

  /** Sizes in catalog order (cheapest first), each with its per-year base rate for the card. */
  const sizes = useMemo(() => {
    if (!plans) return [];
    const seen = new Map<string, number>();
    for (const p of plans) {
      // The 1-year price IS the yearly rate; derive for safety if a size somehow lacks one.
      if (!seen.has(p.size)) seen.set(p.size, p.years === 1 ? p.amountCents : Math.round(p.amountCents / p.years));
      if (p.years === 1) seen.set(p.size, p.amountCents);
    }
    return [...seen.entries()].map(([s, perYearCents]) => ({ size: s, perYearCents }));
  }, [plans]);

  const terms = useMemo(
    () => (plans ?? []).filter((p) => p.size === size).sort((a, b) => a.years - b.years),
    [plans, size],
  );
  const current = terms.find((p) => p.years === years) ?? terms[0];

  return (
    <Modal
      title="Subscribe to keep backing up"
      icon="workspace_premium"
      onClose={onClose}
      footer={
        entitlement.checkingOut ? undefined : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Not now
            </Button>
            <Button variant="primary" disabled={!current} onClick={() => current && onSubscribe(current.priceId)}>
              {current ? `Subscribe to ${current.size}` : "Subscribe"}
            </Button>
          </>
        )
      }
    >
      {entitlement.checkingOut ? (
        <p className="cs-quote-lead">
          Finish checking out in your browser. This updates on its own once you&apos;re done — you can leave
          this open.
        </p>
      ) : (
        <>
          <p className="cs-quote-lead">
            A subscription lets coldstorage keep backing up your new and changed files. Anything you&apos;ve
            already stored stays available to get back, subscription or not.
          </p>

          {loadError ? (
            <>
              <Alert>{loadError}</Alert>
              <Button variant="secondary" onClick={() => setLoadNonce((n) => n + 1)}>
                Try again
              </Button>
            </>
          ) : plans === null ? (
            <p className="cs-plan-lock">Loading plans…</p>
          ) : (
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
          )}
        </>
      )}
      {entitlement.error && <Alert>{entitlement.error}</Alert>}
    </Modal>
  );
};
