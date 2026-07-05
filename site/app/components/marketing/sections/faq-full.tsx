/*
 * Section — FAQ · full: all six questions (where · sync · cost · lapse · floor · wind-down).
 * Ported from `design-mirror/marketing/faq-full.jsx`: IIFE/`window` global → named export,
 * DS-bundle Accordion → ours. Upstream keyed `CS_FAQ` object → the `FAQ` array (already in
 * the Master's order), so it feeds the Accordion directly.
 */
import { Reveal } from "~/lib/marketing/motion";
import { Accordion } from "~/components/ds/accordion";
import { FAQ } from "~/lib/marketing/content";

export function SectionFaqFull() {
  return (
    <section
      id="faq"
      className="csf-band"
      data-screen-label="FAQ"
      style={{ borderTop: "1px solid var(--border-subtle)" }}
    >
      <div className="csf-container csf-container--text">
        <span className="csf-eyebrow">Fair questions</span>
        <h2 className="csf-title" style={{ fontSize: "var(--text-3xl)", marginBottom: 24 }}>
          Asked before you had to ask
        </h2>
        <Reveal>
          <Accordion items={FAQ} defaultOpen={0} />
        </Reveal>
      </div>
    </section>
  );
}
