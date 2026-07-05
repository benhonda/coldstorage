/*
 * Section — Closing CTA · somewhere else: "Put what you can't lose somewhere else".
 * Ported from `design-mirror/marketing/closing-somewhere-else.jsx`: IIFE/`window` global →
 * named export, DS-bundle CtaPanel/Button → ours. Copy kept verbatim from the mirror.
 */
import { Reveal } from "~/lib/marketing/motion";
import { CtaPanel } from "~/components/ds/cta-panel";
import { Button } from "~/components/ds/button";

export function SectionClosingSomewhereElse() {
  return (
    <section className="csf-band" data-screen-label="Closing CTA">
      <div className="csf-container">
        <Reveal>
          <CtaPanel
            eyebrow="ColdStorage for Mac"
            title="Put what you can't lose somewhere else"
            lead="Download the app, point it at what matters, and walk away. We'll take it from here."
            note="Free app · macOS 14 or later · storage from $9.99 a year"
          >
            <Button variant="primary" size="lg" icon="download">
              Download for Mac
            </Button>
          </CtaPanel>
        </Reveal>
      </div>
    </section>
  );
}
