/*
 * Section — Pricing · stretch: DS PricingTable under "Buy a stretch of years"; two-column
 * fine print. Ported from `design-mirror/marketing/pricing-stretch.jsx`: IIFE/`window`
 * global → named export, shared globals → imports, DS-bundle PricingTable/FinePrint → ours,
 * upstream `CS_*` names → the content.ts exports.
 */
import { Reveal } from "~/lib/marketing/motion";
import { PricingTable } from "~/components/ds/pricing-table";
import { FinePrint } from "~/components/ds/fine-print";
import {
  TERMS,
  pricingTiers,
  ENTERPRISE,
  RATE_LOCK,
  TAPER_NOTE,
  TIERS_NOTE,
} from "~/lib/marketing/content";

export function SectionPricingStretch() {
  return (
    <section
      id="pricing"
      className="csf-band"
      data-screen-label="Pricing"
      style={{ borderTop: "1px solid var(--border-subtle)" }}
    >
      <div className="csf-container">
        <Reveal>
          <div style={{ textAlign: "center", maxWidth: "52ch", margin: "0 auto 40px" }}>
            <span className="csf-eyebrow">Pricing</span>
            <h2 className="csf-title">Buy a stretch of years</h2>
            <p className="csf-lead" style={{ marginTop: 14 }}>
              Pick a size, pick how long to lock it — like buying a drive, you own the span up
              front. {TIERS_NOTE}
            </p>
          </div>
        </Reveal>
        <Reveal delay={80}>
          <PricingTable
            terms={TERMS}
            tiers={pricingTiers()}
            defaultTerm="1yr"
            enterprise={ENTERPRISE}
          />
        </Reveal>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
            gap: "var(--gutter)",
            marginTop: 28,
          }}
        >
          <FinePrint style={{ margin: 0 }}>{RATE_LOCK}</FinePrint>
          <FinePrint style={{ margin: 0 }}>{TAPER_NOTE}</FinePrint>
        </div>
      </div>
    </section>
  );
}
