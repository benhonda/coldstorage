/* Section — How it works · list: editorial split — heading left, four
   numbered rows right. Injects .csA-steps CSS. */

(function () {
  csInjectStyle("section-style-how-list", `
    .csA-steps { display: flex; flex-direction: column; }
    .csA-step { display: grid; grid-template-columns: 64px 1fr; gap: 20px; padding: 26px 0; border-top: 1px solid var(--border-subtle); }
    .csA-step:first-child { border-top: 0; padding-top: 0; }
    @media (max-width: 880px) { .csA-step { grid-template-columns: 44px 1fr; gap: 14px; } }
  `);

  function SectionHowList() {
    return (
      <section id="how" className="csf-band" data-screen-label="How it works" style={{ borderTop: "1px solid var(--border-subtle)" }}>
        <div className="csf-container">
          <div className="csf-split">
            <div>
              <span className="csf-eyebrow">How it works</span>
              <h2 className="csf-title">Four steps, one of them honest to a fault</h2>
              <p className="csf-lead" style={{ marginTop: 14, fontSize: "var(--text-lg)" }}>
                Step four is the part most storage products keep in the fine print. We'd rather
                you read it now than meet it later.
              </p>
            </div>
            <div className="csA-steps">
              {CS_HOW_STEPS.map((s, i) => (
                <Reveal className="csA-step" key={s.n} delay={i * 80} y={14}>
                  <span className="csf-mono" style={{ font: "500 15px/1 var(--font-mono)", color: "var(--accent-text)", paddingTop: 6 }}>{s.n}</span>
                  <div>
                    <div style={{ font: "600 20px/1.25 var(--font-ui)", color: "var(--text-primary)" }}>{s.title}</div>
                    <p style={{ margin: "8px 0 0", font: "400 15px/1.6 var(--font-ui)", color: "var(--text-secondary)", maxWidth: "52ch", textWrap: "pretty" }}>{s.body}</p>
                  </div>
                </Reveal>
              ))}
            </div>
          </div>
        </div>
      </section>
    );
  }

  window.SectionHowList = SectionHowList;
})();
