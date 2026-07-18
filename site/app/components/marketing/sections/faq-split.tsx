/*
 * Section — FAQ · split: title left, accordion in a white card right.
 * Ported from `design-mirror/marketing/master-sections.jsx` → `SectionMFaq`:
 * `csInjectStyle` → a co-located stylesheet, `window` globals → imports.
 * Replaces the old full-width `SectionFaqFull` (same DS Accordion, new layout + copy).
 */
import "./faq-split.css";
import { Reveal } from "~/lib/marketing/motion";
import { FAQ } from "~/lib/marketing/content";
import { Accordion } from "~/components/ds/accordion";

export function SectionFaqSplit() {
  return (
    <section
      id="faq"
      className="csf-band"
      data-screen-label="FAQ"
      style={{ borderTop: "1px solid var(--border-subtle)" }}
    >
      <div className="csf-container">
        <div className="cs-faq">
          <div>
            <span className="csf-eyebrow">{FAQ.eyebrow}</span>
            <h2 className="csf-title">{FAQ.title}</h2>
          </div>
          <Reveal>
            <div className="cs-faq__card">
              <Accordion items={FAQ.items} defaultOpen={0} />
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
