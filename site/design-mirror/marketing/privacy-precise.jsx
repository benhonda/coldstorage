/* Section — Privacy · precise: "Private, stated precisely" copy angle +
   commitments card. */

(function () {
  const { Card, KeyValueRow } = window.ColdstorageDesignSystem_41ebaf;

  function SectionPrivacyPrecise() {
    return (
      <section id="privacy" className="csf-band" data-screen-label="Privacy — stated precisely" style={{ borderTop: "1px solid var(--border-subtle)" }}>
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
              <p style={{ margin: "14px 0 0", font: "400 15px/1.6 var(--font-ui)", color: "var(--text-secondary)", maxWidth: "48ch", textWrap: "pretty" }}>
                {CS_KEY_ESCROW_LINE}
              </p>
            </div>
            </Reveal>
            <Reveal delay={130}>
            <Card>
              <div style={{ font: "600 13px/1 var(--font-ui)", letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-tertiary)", marginBottom: 6 }}>
                Commitments, in writing
              </div>
              {CS_PRIVACY_ROWS.map((r) => (
                <KeyValueRow key={r.label} label={r.label} value={r.value} icon={r.icon} />
              ))}
            </Card>
            </Reveal>
          </div>
        </div>
      </section>
    );
  }

  window.SectionPrivacyPrecise = SectionPrivacyPrecise;
})();
