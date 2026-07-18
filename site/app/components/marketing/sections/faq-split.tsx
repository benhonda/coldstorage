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

export type SectionFaqSplitProps = {
  /**
   * Renders the section's own eyebrow + `<h2>`. On the landing page that head is what
   * introduces the section; on `/faq` the `<PageHero>` already says the same words in an
   * `<h1>`, so the standalone route turns it off rather than saying them twice.
   */
  showHead?: boolean;
};

export function SectionFaqSplit({ showHead = true }: SectionFaqSplitProps) {
  return (
    <section
      id="faq"
      className={showHead ? "csf-band" : "csf-band csf-band--flush-top"}
      data-screen-label="FAQ"
      style={showHead ? { borderTop: "1px solid var(--border-subtle)" } : undefined}
    >
      <div className="csf-container">
        <div className={showHead ? "cs-faq" : "cs-faq cs-faq--headless"}>
          {showHead ? (
            <div>
              <span className="csf-eyebrow">{FAQ.eyebrow}</span>
              <h2 className="csf-title">{FAQ.title}</h2>
            </div>
          ) : null}
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
