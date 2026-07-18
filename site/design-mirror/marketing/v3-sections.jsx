/* Concept 3 — "Editorial split". Same copy as Concept 2 (via shared/landing-copy.jsx).
   Left-aligned hero with a tall media slot, full-bleed demo band, numbered privacy
   ledger, side-by-side pricing. Media areas are <image-slot> drop zones. */
(function () {
  const { Button, Chip, Accordion } = window.ColdstorageDesignSystem_41ebaf;

  /* ── 1 · Hero ── */
  function SectionV3Hero() {
    csInjectStyle("v3-hero-css", `
      .csV3-hero { display: grid; grid-template-columns: 1.05fr 1fr; gap: 48px; align-items: center; }
      .csV3-hero h1 span { display: block; }
      .csV3-heromedia { height: 520px; }
      @media (max-width: 960px) { .csV3-hero { grid-template-columns: 1fr; } .csV3-heromedia { height: 340px; } }
    `);
    return (
      <section className="csf-band" data-screen-label="Hero" style={{ paddingTop: 64 }}>
        <div className="csf-container">
          <div className="csV3-hero">
            <div>
              <h1 className="csf-headline" style={{ margin: 0 }}>
                {LC.hero.words.map((w, i) => (
                  <Reveal key={w} delay={i * 140} y={14}><span>{w}</span></Reveal>
                ))}
              </h1>
              <Reveal delay={420}>
                <p className="csf-lead" style={{ margin: "24px 0 0", maxWidth: "40ch" }}>{LC.hero.lead}</p>
              </Reveal>
              <Reveal delay={540}>
                <div style={{ display: "flex", alignItems: "center", gap: 20, marginTop: 36, flexWrap: "wrap" }}>
                  <Button variant="primary" size="lg" icon="download">{LC.hero.cta}</Button>
                  <span style={{ font: "400 14px/1.4 var(--font-ui)", color: "var(--text-tertiary)" }}>{LC.hero.note}</span>
                </div>
              </Reveal>
            </div>
            <Reveal delay={200} y={20}>
              <div className="csV3-heromedia">
                <image-slot id="c3-hero-media" shape="rounded" radius="24" placeholder="Drop hero screenshot or video still"></image-slot>
              </div>
            </Reveal>
          </div>
        </div>
      </section>
    );
  }

  /* ── 2 · Drag in what you want to keep ── */
  function SectionV3DragIn() {
    return (
      <section id="how" className="csf-band" data-screen-label="Drag in" style={{ borderTop: "1px solid var(--border-subtle)" }}>
        <div className="csf-container">
          <div className="csf-split-head">
            <div>
              <span className="csf-eyebrow">{LC.how.eyebrow}</span>
              <h2 className="csf-title">{LC.how.title}</h2>
            </div>
            <p className="csf-lead" style={{ fontSize: "var(--text-lg)" }}>{LC.how.body}</p>
          </div>
          <Reveal y={24}>
            <div style={{ marginTop: 48, aspectRatio: "21 / 9", minHeight: 320 }}>
              <image-slot id="c3-how-media" shape="rounded" radius="24" placeholder="Drop app demo — drag-in screen recording still"></image-slot>
            </div>
          </Reveal>
        </div>
      </section>
    );
  }

  /* ── 3 · Only you can open them ── */
  function SectionV3Privacy() {
    csInjectStyle("v3-privacy-css", `
      .csV3-priv { display: grid; grid-template-columns: 1fr 1.2fr; gap: 64px; align-items: start; }
      .csV3-priv-left { position: sticky; top: 120px; }
      .csV3-row { display: grid; grid-template-columns: 64px 1fr; gap: 20px; padding: 28px 0; border-top: 1px solid var(--border-subtle); align-items: baseline; }
      .csV3-row:last-child { border-bottom: 1px solid var(--border-subtle); }
      .csV3-num { font: 500 15px/1 var(--font-mono); color: var(--accent-text); }
      @media (max-width: 880px) { .csV3-priv { grid-template-columns: 1fr; gap: 32px; } .csV3-priv-left { position: static; } }
    `);
    return (
      <section id="privacy" className="csf-band" data-screen-label="Privacy" style={{ borderTop: "1px solid var(--border-subtle)" }}>
        <div className="csf-container">
          <div className="csV3-priv">
            <div className="csV3-priv-left">
              <span className="csf-eyebrow">{LC.privacy.eyebrow}</span>
              <h2 className="csf-title">{LC.privacy.title}</h2>
              <p className="csf-lead" style={{ marginTop: 16, fontSize: "var(--text-lg)" }}>{LC.privacy.lead}</p>
            </div>
            <div>
              {LC.privacy.steps.map((s, i) => (
                <Reveal key={s.icon} delay={i * 90} y={12}>
                  <div className="csV3-row">
                    <span className="csV3-num">0{i + 1}</span>
                    <div>
                      <div style={{ font: "600 19px/1.3 var(--font-ui)", color: "var(--text-primary)" }}>{s.title}</div>
                      <p style={{ margin: "8px 0 0", font: "400 15px/1.55 var(--font-ui)", color: "var(--text-secondary)", textWrap: "pretty" }}>{s.body}</p>
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

  /* ── 4 · Pricing — both halves visible, side by side ── */
  function SectionV3Pricing() {
    csInjectStyle("v3-pricing-css", `
      .csV3-price { display: grid; grid-template-columns: 1.15fr 1fr; gap: 24px; align-items: start; margin-top: 48px; }
      .csV3-card { background: var(--surface-card); border: 1px solid var(--border-card); border-radius: 24px; box-shadow: var(--shadow-card); padding: 24px; }
      .csV3-cardlabel { font: 400 13px/1 var(--font-ui); color: var(--text-tertiary); text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 8px; }
      .csV3-table { width: 100%; border-collapse: separate; border-spacing: 0; }
      .csV3-table th { font: 400 13px/1 var(--font-ui); color: var(--text-tertiary); text-align: left; padding: 12px 12px 10px; }
      .csV3-table td { padding: 0 12px; height: 60px; transition: background 150ms var(--ease-out); }
      .csV3-table td:first-child { border-radius: 14px 0 0 14px; }
      .csV3-table td:last-child { border-radius: 0 14px 14px 0; }
      .csV3-table tbody tr:hover td { background: var(--surface-hover); }
      .csV3-numcol { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
      .csV3-krow { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 18px 4px; border-top: 1px solid var(--border-subtle); }
      .csV3-krow:first-of-type { border-top: 0; }
      @media (max-width: 960px) { .csV3-price { grid-template-columns: 1fr; } }
    `);
    return (
      <section id="pricing" className="csf-band" data-screen-label="Pricing" style={{ borderTop: "1px solid var(--border-subtle)" }}>
        <div className="csf-container">
          <div className="csf-split-head">
            <div>
              <span className="csf-eyebrow">{LC.pricing.eyebrow}</span>
              <h2 className="csf-title">{LC.pricing.title}</h2>
            </div>
            <p className="csf-lead">{LC.pricing.leadNoTabs}</p>
          </div>
          <Reveal y={20}>
            <div className="csV3-price">
              <div className="csV3-card">
                <div className="csV3-cardlabel">Storage</div>
                <table className="csV3-table">
                  <thead>
                    <tr><th>Size</th><th className="csV3-numcol">Per year</th><th className="csV3-numcol">Per month</th></tr>
                  </thead>
                  <tbody>
                    {LC.pricing.tiers.map((t) => (
                      <tr key={t.size}>
                        <td>
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 12 }}>
                            <span className="csf-mono" style={{ font: "500 16px/1 var(--font-mono)", color: "var(--text-primary)" }}>{t.size}</span>
                            {t.free && <Chip size="sm">free · no card</Chip>}
                          </span>
                        </td>
                        <td className="csV3-numcol" style={{ font: "600 17px/1 var(--font-ui)", color: t.free ? "var(--accent-text)" : "var(--text-primary)" }}>{t.year}</td>
                        <td className="csV3-numcol csf-mono" style={{ font: "400 14px/1 var(--font-mono)", color: "var(--text-tertiary)" }}>{t.month}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "18px 12px 0" }}>
                  <span style={{ font: "400 15px/1.5 var(--font-ui)", color: "var(--text-secondary)" }}>{LC.pricing.moreLead} <a href="#" style={{ font: "600 15px/1.5 var(--font-ui)", color: "var(--accent-text)", textDecoration: "none" }}>{LC.pricing.moreLink}</a>.</span>
                  <span style={{ font: "400 13px/1.5 var(--font-ui)", color: "var(--text-tertiary)" }}>{LC.pricing.renewNote}</span>
                </div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                <div className="csV3-card">
                  <div className="csV3-cardlabel">{LC.pricing.retrievalTitle}</div>
                  <p style={{ margin: "4px 0 8px", font: "400 15px/1.55 var(--font-ui)", color: "var(--text-secondary)", textWrap: "pretty" }}>{LC.pricing.retrievalLead}</p>
                  {LC.pricing.retrievalRows.map((r) => (
                    <div className="csV3-krow" key={r.label}>
                      <span style={{ font: "400 16px/1.4 var(--font-ui)", color: "var(--text-primary)" }}>{r.label}</span>
                      <span style={{ font: "600 17px/1 var(--font-ui)", color: r.value === "Free" ? "var(--accent-text)" : "var(--text-primary)" }}>{r.value}</span>
                    </div>
                  ))}
                  <div style={{ display: "flex", alignItems: "center", gap: 8, paddingTop: 16, borderTop: "1px solid var(--border-subtle)", font: "400 15px/1.5 var(--font-ui)", color: "var(--text-secondary)" }}>
                    <span className="csf-icon" style={{ fontSize: 18, color: "var(--text-tertiary)" }}>schedule</span>
                    {LC.pricing.readyNote}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 14, alignItems: "flex-start", background: "var(--surface-raised)", border: "1px solid var(--border-subtle)", borderRadius: 20, padding: "20px 24px" }}>
                  <span className="csf-icon" style={{ fontSize: 22, color: "var(--accent-text)", flexShrink: 0 }}>cloud_download</span>
                  <span style={{ font: "400 15px/1.55 var(--font-ui)", color: "var(--text-secondary)", textWrap: "pretty" }}>
                    {LC.pricing.callout}{" "}
                    <a href="#" style={{ font: "600 15px/1 var(--font-ui)", color: "var(--accent-text)", textDecoration: "none", whiteSpace: "nowrap" }}>{LC.pricing.calloutLink}</a>
                  </span>
                </div>
                <FinePrint style={{ margin: 0, padding: "0 8px" }}>{LC.pricing.finePrint}</FinePrint>
              </div>
            </div>
          </Reveal>
        </div>
      </section>
    );
  }

  /* ── 5 · FAQ — title left, accordion right ── */
  function SectionV3Faq() {
    csInjectStyle("v3-faq-css", `
      .csV3-faq { display: grid; grid-template-columns: 1fr 1.6fr; gap: 64px; align-items: start; }
      @media (max-width: 880px) { .csV3-faq { grid-template-columns: 1fr; gap: 24px; } }
    `);
    return (
      <section id="faq" className="csf-band" data-screen-label="FAQ" style={{ borderTop: "1px solid var(--border-subtle)" }}>
        <div className="csf-container">
          <div className="csV3-faq">
            <div>
              <span className="csf-eyebrow">{LC.faq.eyebrow}</span>
              <h2 className="csf-title">{LC.faq.title}</h2>
            </div>
            <Reveal><Accordion items={LC.faq.items} defaultOpen={0} /></Reveal>
          </div>
        </div>
      </section>
    );
  }

  /* ── 6 · Close — quiet full-width band ── */
  function SectionV3Close() {
    csInjectStyle("v3-close-css", `
      .csV3-close { display: flex; justify-content: space-between; align-items: center; gap: 32px; flex-wrap: wrap; padding: 48px 0; border-top: 1px solid var(--border-subtle); }
    `);
    return (
      <section className="csf-band" data-screen-label="Closing CTA" style={{ paddingBottom: 0 }}>
        <div className="csf-container">
          <Reveal>
            <div className="csV3-close">
              <div>
                <span className="csf-eyebrow">{LC.close.eyebrow}</span>
                <h2 className="csf-title" style={{ margin: 0 }}>{LC.close.title}</h2>
                <p className="csf-lead" style={{ margin: "10px 0 0", fontSize: "var(--text-lg)" }}>{LC.close.lead}</p>
              </div>
              <Button variant="primary" size="lg" icon="download">{LC.close.cta}</Button>
            </div>
          </Reveal>
        </div>
      </section>
    );
  }

  Object.assign(window, { SectionV3Hero, SectionV3DragIn, SectionV3Privacy, SectionV3Pricing, SectionV3Faq, SectionV3Close });
})();
