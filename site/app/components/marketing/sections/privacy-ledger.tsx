/*
 * Section — Privacy · ledger: sticky statement left, numbered rows right.
 * Ported from `Claude design · v3-sections.jsx` → `SectionV3Privacy`
 * (the Master composes Concept 3's privacy, not Concept 4's panel):
 * `csInjectStyle` → a co-located stylesheet, `window` globals → imports.
 *
 * Replaces the old `SectionPrivacyPrecise` commitments table. Note the claim changed
 * upstream: this states the key never leaves the user's Mac, where the old section
 * disclosed key escrow. That matches where the product is heading — see SPEC.
 */
import "./privacy-ledger.css";
import { Reveal } from "~/lib/marketing/motion";
import { PRIVACY } from "~/lib/marketing/content";

export function SectionPrivacyLedger() {
  return (
    <section
      id="privacy"
      className="csf-band"
      data-screen-label="Privacy"
      style={{ borderTop: "1px solid var(--border-subtle)" }}
    >
      <div className="csf-container">
        <div className="cs-privacy">
          <div className="cs-privacy__left">
            <span className="csf-eyebrow">{PRIVACY.eyebrow}</span>
            <h2 className="csf-title">{PRIVACY.title}</h2>
            <p className="csf-lead" style={{ marginTop: 16, fontSize: "var(--text-lg)" }}>
              {PRIVACY.lead}
            </p>
          </div>
          <div className="cs-privacy__rows">
            {PRIVACY.steps.map((s, i) => (
              <Reveal key={s.icon} delay={i * 90} y={12}>
                <div className="cs-privacy__row">
                  <span className="cs-privacy__num">{String(i + 1).padStart(2, "0")}</span>
                  <div>
                    <div
                      style={{
                        font: "600 19px/1.3 var(--font-ui)",
                        color: "var(--text-primary)",
                      }}
                    >
                      {s.title}
                    </div>
                    <p
                      style={{
                        margin: "8px 0 0",
                        font: "400 15px/1.55 var(--font-ui)",
                        color: "var(--text-secondary)",
                        textWrap: "pretty",
                      }}
                    >
                      {s.body}
                    </p>
                  </div>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
