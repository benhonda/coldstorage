/*
 * Section — Pricing · tabbed: storage sizes and retrieval costs on two tabs.
 * Ported from `design-mirror/marketing/master-sections.jsx` → `SectionMPricing`
 * (+ its `MPricingStorage` / `MPricingRetrieval` panels): `csInjectStyle` → a co-located
 * stylesheet, `window` globals → imports, upstream `Chip` → our DS `Badge`.
 *
 * Replaces the old `SectionPricingStretch` term-matrix (3 sizes × 4 rate-lock terms).
 * Upstream moved to six flat yearly sizes with a free 25 GB tier, plus pass-through
 * retrieval pricing. `/pricing` renders this same section, so both stay in step.
 *
 * The tablist is a real roving-focus tab implementation (arrow keys, roving tabindex) —
 * upstream's preview wires only onClick, which strands keyboard users on tab one.
 */
import "./pricing-tabbed.css";
import * as React from "react";
import { Reveal } from "~/lib/marketing/motion";
import { PRICING } from "~/lib/marketing/content";
import { Badge } from "~/components/ds/badge";
import { Button } from "~/components/ds/button";
import { FinePrint } from "~/components/ds/fine-print";
import { DOWNLOAD_PATH } from "~/lib/marketing/download";

type TabId = "storage" | "retrieval";

// Labels come from PRICING.ui — content.ts is the copy SSOT, including microcopy.
const TABS: { value: TabId; label: string; sub: string }[] = [
  { value: "storage", ...PRICING.ui.tabs.storage },
  { value: "retrieval", ...PRICING.ui.tabs.retrieval },
];

export function SectionPricingTabbed() {
  const [tab, setTab] = React.useState<TabId>("storage");
  const baseId = React.useId();
  const tabRefs = React.useRef<(HTMLButtonElement | null)[]>([]);

  // Arrow-key navigation across the tablist, per the WAI-ARIA tabs pattern.
  function onKeyDown(e: React.KeyboardEvent, i: number) {
    const dir = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    const next = (i + dir + TABS.length) % TABS.length;
    setTab(TABS[next].value);
    tabRefs.current[next]?.focus();
  }

  return (
    <section
      id="pricing"
      className="csf-band"
      data-screen-label="Pricing"
      style={{ borderTop: "1px solid var(--border-subtle)" }}
    >
      <div className="csf-container">
        <div className="csf-split-head">
          <div>
            <span className="csf-eyebrow">{PRICING.eyebrow}</span>
            <h2 className="csf-title">{PRICING.title}</h2>
          </div>
          <p className="csf-lead">{PRICING.leadNoTabs}</p>
        </div>
        <Reveal y={20}>
          <div className="cs-pricing__tabs" role="tablist" aria-label="Pricing">
            {TABS.map((t, i) => {
              const active = tab === t.value;
              return (
                <button
                  key={t.value}
                  ref={(el) => {
                    tabRefs.current[i] = el;
                  }}
                  type="button"
                  role="tab"
                  id={`${baseId}-tab-${t.value}`}
                  aria-selected={active}
                  aria-controls={`${baseId}-panel-${t.value}`}
                  tabIndex={active ? 0 : -1}
                  className="cs-pricing__tab"
                  data-active={active}
                  onClick={() => setTab(t.value)}
                  onKeyDown={(e) => onKeyDown(e, i)}
                >
                  <span className="cs-pricing__tab-t">{t.label}</span>
                  <span className="cs-pricing__tab-s">{t.sub}</span>
                </button>
              );
            })}
          </div>
          {/* `key={tab}` re-mounts the panel so the fade-in animation replays on switch. */}
          <div
            key={tab}
            className="cs-pricing__panel"
            role="tabpanel"
            id={`${baseId}-panel-${tab}`}
            aria-labelledby={`${baseId}-tab-${tab}`}
            tabIndex={0}
          >
            {tab === "storage" ? <PricingStorage /> : <PricingRetrieval />}
          </div>
        </Reveal>
      </div>
    </section>
  );
}

/** Tab one — the six storage sizes, cheapest first, free tier flagged. */
function PricingStorage() {
  return (
    <div className="cs-pricing__card">
      <table className="cs-pricing__table">
        <thead>
          <tr>
            <th scope="col">{PRICING.ui.columns.size}</th>
            <th scope="col" className="cs-pricing__num">
              {PRICING.ui.columns.perYear}
            </th>
            <th scope="col" className="cs-pricing__num">
              {PRICING.ui.columns.perMonth}
            </th>
            {/* CTA column — no header text, but it still needs an accessible name. */}
            <th scope="col">
              <span className="cs-visually-hidden">{PRICING.ui.columns.cta}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {PRICING.tiers.map((t) => (
            <tr key={t.size}>
              <td>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 12 }}>
                  <span
                    className="csf-mono"
                    style={{
                      font: "500 16px/1 var(--font-mono)",
                      color: "var(--text-primary)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {t.size}
                  </span>
                  {t.free && <Badge tone="accent">{PRICING.ui.freeBadge}</Badge>}
                </span>
              </td>
              <td
                className="cs-pricing__num"
                style={{
                  font: "600 17px/1 var(--font-ui)",
                  color: t.free ? "var(--accent-text)" : "var(--text-primary)",
                }}
              >
                {t.year}
              </td>
              <td
                className="cs-pricing__num csf-mono"
                style={{ font: "400 14px/1 var(--font-mono)", color: "var(--text-tertiary)" }}
              >
                {t.month}
              </td>
              <td className="cs-pricing__cta">
                {/* Every row routes to the download. Plan selection happens inside the app
                    (sign in → pick a size → Paddle), and `/checkout` is only the overlay
                    opener for a transaction Paddle has already created — it can't take a
                    cold visitor. Upstream leaves these as `href="#"`; this is the honest
                    target until a web plan-picker exists. */}
                <Button variant={t.free ? "primary" : "secondary"} size="sm" href={DOWNLOAD_PATH}>
                  {t.free ? PRICING.ui.ctaFree : PRICING.ui.ctaPaid}
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "18px 12px 0" }}>
        <span style={{ font: "400 15px/1.5 var(--font-ui)", color: "var(--text-secondary)" }}>
          {PRICING.moreLead}{" "}
          <a className="cs-pricing__link" href="mailto:support@m.coldstorage.sh">
            {PRICING.moreLink}
          </a>
          .
        </span>
        <span style={{ font: "400 13px/1.5 var(--font-ui)", color: "var(--text-tertiary)" }}>
          {PRICING.renewNote}
        </span>
      </div>
    </div>
  );
}

/** Tab two — what pulling files back out costs, at pass-through rates. */
function PricingRetrieval() {
  return (
    <div className="cs-pricing__retrieval">
      <div className="cs-pricing__card">
        <p
          style={{
            margin: "4px 0 8px",
            font: "400 15px/1.55 var(--font-ui)",
            color: "var(--text-secondary)",
            textWrap: "pretty",
          }}
        >
          {PRICING.retrievalLead}
        </p>
        {PRICING.retrievalRows.map((r) => (
          <div className="cs-pricing__krow" key={r.label}>
            <span style={{ font: "400 16px/1.4 var(--font-ui)", color: "var(--text-primary)" }}>
              {r.label}
            </span>
            <span
              style={{
                font: "600 17px/1 var(--font-ui)",
                color: r.value === "Free" ? "var(--accent-text)" : "var(--text-primary)",
              }}
            >
              {r.value}
            </span>
          </div>
        ))}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            paddingTop: 16,
            borderTop: "1px solid var(--border-subtle)",
            font: "400 15px/1.5 var(--font-ui)",
            color: "var(--text-secondary)",
          }}
        >
          <span
            className="csf-icon"
            aria-hidden="true"
            style={{ fontSize: 18, color: "var(--text-tertiary)" }}
          >
            schedule
          </span>
          {PRICING.readyNote}
        </div>
      </div>
      <div className="cs-pricing__callout">
        <span
          className="csf-icon"
          aria-hidden="true"
          style={{ fontSize: 22, color: "var(--accent-text)", flexShrink: 0 }}
        >
          cloud_download
        </span>
        <span
          style={{
            font: "400 15px/1.55 var(--font-ui)",
            color: "var(--text-secondary)",
            textWrap: "pretty",
          }}
        >
          {PRICING.callout}{" "}
          {/* The copy doc's §5 links this to /how-it-works — that page now exists. */}
          <a className="cs-pricing__link" href="/how-it-works" style={{ whiteSpace: "nowrap" }}>
            {PRICING.calloutLink}
          </a>
        </span>
      </div>
      <FinePrint style={{ margin: 0, padding: "0 8px" }}>{PRICING.finePrint}</FinePrint>
    </div>
  );
}
