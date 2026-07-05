/*
 * DS · PricingTable — reimplemented from the compiled DS bundle's API. A segmented
 * term selector switches which price shows across the tier cards; the featured tier
 * is highlighted. Client-interactive (term state) but SSR-safe (initial render uses
 * `defaultTerm`, matching the server).
 */
import "./pricing-table.css";
import * as React from "react";
import { Button } from "./button";
import { Badge } from "./badge";
import type { PricingTier, Term } from "~/lib/marketing/content";

export type PricingTableProps = {
  terms: Term[];
  tiers: PricingTier[];
  defaultTerm: string;
  enterprise: { title: string; note: string; cta: string };
};

export function PricingTable({ terms, tiers, defaultTerm, enterprise }: PricingTableProps) {
  const [term, setTerm] = React.useState(defaultTerm);

  return (
    <div className="csf-pricing">
      {/* segmented term control */}
      <div className="csf-seg" role="tablist" aria-label="Billing term">
        {terms.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={term === t.id}
            className={`csf-seg__btn${term === t.id ? " is-active" : ""}`}
            onClick={() => setTerm(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* tier cards */}
      <div className="csf-pricing__grid">
        {tiers.map((tier) => {
          const cell = tier.prices[term];
          return (
            <div
              key={tier.name}
              className={`csf-tier${tier.featured ? " csf-tier--featured" : ""}`}
            >
              <div className="csf-tier__head">
                <span className="csf-tier__size">{tier.size}</span>
                {tier.featured ? <Badge tone="accent">Most picked</Badge> : null}
              </div>
              <div className="csf-tier__price">
                <span className="csf-mono">{cell.price}</span>
              </div>
              <div className="csf-tier__period">{cell.period}</div>
              <div className="csf-tier__rate csf-mono">
                {cell.perYear}/yr · {cell.perMonth}/mo
              </div>
              <div className="csf-tier__cta">
                <Button variant={tier.featured ? "primary" : "ghost"} size="sm">
                  {tier.ctaLabel}
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      {/* enterprise note */}
      <div className="csf-enterprise">
        <div>
          <div className="csf-enterprise__title">{enterprise.title}</div>
          <div className="csf-enterprise__note">{enterprise.note}</div>
        </div>
        <Button variant="ghost" size="sm">
          {enterprise.cta}
        </Button>
      </div>
    </div>
  );
}
