/*
 * Section — Privacy · precise: "Private, stated precisely" copy + commitments card.
 * Ported from `design-mirror/marketing/privacy-precise.jsx`: IIFE/`window` global → named
 * export, shared globals → imports, DS-bundle components → our DS Card/KeyValueRow.
 */
import { Reveal } from "~/lib/marketing/motion";
import { Card } from "~/components/ds/card";
import { KeyValueRow } from "~/components/ds/key-value-row";
import { KEY_ESCROW_LINE, PRIVACY_ROWS } from "~/lib/marketing/content";

export function SectionPrivacyPrecise() {
  return (
    <section
      id="privacy"
      className="csf-band"
      data-screen-label="Privacy — stated precisely"
      style={{ borderTop: "1px solid var(--border-subtle)" }}
    >
      <div className="csf-container">
        <div className="csf-split">
          <Reveal>
            <div>
              <span className="csf-eyebrow">Privacy</span>
              <h2 className="csf-title">Private, stated precisely</h2>
              <p className="csf-lead" style={{ marginTop: 14, fontSize: "var(--text-lg)" }}>
                Privacy claims tend to inflate. Ours match the architecture — what it does
                today, not what it might do someday. Your files are scrambled on your Mac
                before they leave it, so what's stored is data nobody can read.
              </p>
              <p
                style={{
                  margin: "14px 0 0",
                  font: "400 15px/1.6 var(--font-ui)",
                  color: "var(--text-secondary)",
                  maxWidth: "48ch",
                  textWrap: "pretty",
                }}
              >
                {KEY_ESCROW_LINE}
              </p>
            </div>
          </Reveal>
          <Reveal delay={130}>
            <Card>
              <div
                style={{
                  font: "600 13px/1 var(--font-ui)",
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  color: "var(--text-tertiary)",
                  marginBottom: 6,
                }}
              >
                Commitments, in writing
              </div>
              {PRIVACY_ROWS.map((r) => (
                <KeyValueRow key={r.label} label={r.label} value={r.value} icon={r.icon} />
              ))}
            </Card>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
