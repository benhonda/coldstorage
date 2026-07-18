/*
 * Section — Closing CTA: accent-tinted centered band.
 * Ported from `design-mirror/marketing/v4-sections.jsx` → `SectionV4Close`.
 * Replaces the old CtaPanel-based `SectionClosingSomewhereElse`; upstream traded the
 * panel for a full-bleed tinted band that closes the page.
 */
import { Reveal } from "~/lib/marketing/motion";
import { DOWNLOAD_START_PATH } from "~/lib/marketing/download";
import { CLOSE } from "~/lib/marketing/content";
import { Button } from "~/components/ds/button";

export function SectionClosingBand() {
  return (
    <section
      data-screen-label="Closing CTA"
      style={{
        background: "var(--accent-subtle)",
        borderTop: "1px solid var(--border-subtle)",
      }}
    >
      <div className="csf-container csf-band" style={{ textAlign: "center" }}>
        <Reveal>
          <span className="csf-eyebrow">{CLOSE.eyebrow}</span>
          <h2 className="csf-title" style={{ margin: 0 }}>
            {CLOSE.title}
          </h2>
          <p
            className="csf-lead"
            style={{ margin: "12px auto 0", maxWidth: "40ch", fontSize: "var(--text-lg)" }}
          >
            {CLOSE.lead}
          </p>
          <div style={{ marginTop: 28 }}>
            <Button variant="primary" size="lg" icon="download" href={DOWNLOAD_START_PATH}>
              {CLOSE.cta}
            </Button>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
