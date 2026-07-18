/* Concept 4 — "Cinematic centered". Same copy as Concept 2 (via shared/landing-copy.jsx).
   Centered hero over a wide media stage, reversed how-it-works split, one privacy
   panel, tier-card pricing grid. Media areas are <image-slot> drop zones. */
(function () {
  const { Button, Chip, Accordion } = window.ColdstorageDesignSystem_41ebaf;

  /* ── 1 · Hero — headline over a wide media stage ── */
  function SectionV4Hero() {
    csInjectStyle("v4-hero-css", `
      .csV4-stage { max-width: 1040px; margin: 56px auto 0; aspect-ratio: 16 / 9; min-height: 300px; border-radius: 28px; box-shadow: var(--shadow-card); }
      @media (max-width: 720px) { .csV4-stage { margin-top: 36px; border-radius: 20px; } }
    `);
    return (
      <section className="csf-band" data-screen-label="Hero" style={{ paddingTop: 72 }}>
        <div className="csf-container" style={{ textAlign: "center" }}>
          <h1 className="csf-headline" style={{ margin: "0 auto", maxWidth: "22ch" }}>
            {LC.hero.words.map((w, i) => (
              <Reveal key={w} delay={i * 140} y={12} style={{ display: "inline-block", marginRight: "0.28em" }}>{w}</Reveal>
            ))}
          </h1>
          <Reveal delay={420}>
            <p className="csf-lead" style={{ margin: "22px auto 0", maxWidth: "44ch" }}>{LC.hero.lead}</p>
          </Reveal>
          <Reveal delay={540}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 20, marginTop: 32, flexWrap: "wrap" }}>
              <Button variant="primary" size="lg" icon="download">{LC.hero.cta}</Button>
              <span style={{ font: "400 14px/1.4 var(--font-ui)", color: "var(--text-tertiary)" }}>{LC.hero.note}</span>
            </div>
          </Reveal>
          <Reveal delay={300} y={28}>
            <div className="csV4-stage">
              <image-slot id="c4-hero-media" shape="rounded" radius="28" placeholder="Drop hero demo — app screenshot or video still"></image-slot>
            </div>
          </Reveal>
        </div>
      </section>
    );
  }

  /* ── 2 · Drag in — media left, copy right ── */
  function SectionV4DragIn() {
    csInjectStyle("v4-how-css", `
      .csV4-how { display: grid; grid-template-columns: 1.2fr 1fr; gap: 56px; align-items: center; }
      .csV4-howmedia { aspect-ratio: 4 / 3; min-height: 300px; }
      @media (max-width: 960px) { .csV4-how { grid-template-columns: 1fr; gap: 32px; } .csV4-how > :first-child { order: 2; } }
    `);
    return (
      <section id="how" className="csf-band" data-screen-label="Drag in" style={{ borderTop: "1px solid var(--border-subtle)" }}>
        <div className="csf-container">
          <div className="csV4-how">
            <Reveal y={20}>
              <div className="csV4-howmedia">
                <image-slot id="c4-how-media" shape="rounded" radius="24" placeholder="Drop drag-in demo still"></image-slot>
              </div>
            </Reveal>
            <div>
              <span className="csf-eyebrow">{LC.how.eyebrow}</span>
              <h2 className="csf-title">{LC.how.title}</h2>
              <p className="csf-lead" style={{ marginTop: 14, fontSize: "var(--text-lg)" }}>{LC.how.body}</p>
            </div>
          </div>
        </div>
      </section>
    );
  }

  /* ── 3 · Privacy — one panel, three steps across ── */
  function SectionV4Privacy() {
    csInjectStyle("v4-privacy-css", `
      .csV4-panel { background: var(--surface-card); border: 1px solid var(--border-card); border-radius: 28px; box-shadow: var(--shadow-card); padding: 48px; }
      .csV4-steps { display: grid; grid-template-columns: repeat(3, 1fr); gap: 40px; margin-top: 40px; padding-top: 36px; border-top: 1px solid var(--border-subtle); }
      .csV4-stepicon { width: 48px; height: 48px; border-radius: 999px; background: var(--accent-subtle); display: inline-flex; align-items: center; justify-content: center; }
      @media (max-width: 880px) { .csV4-panel { padding: 28px; } .csV4-steps { grid-template-columns: 1fr; gap: 24px; } }
    `);
    return (
      <section id="privacy" className="csf-band" data-screen-label="Privacy" style={{ borderTop: "1px solid var(--border-subtle)" }}>
        <div className="csf-container">
          <Reveal>
            <div className="csV4-panel">
              <div style={{ maxWidth: "56ch", margin: "0 auto", textAlign: "center" }}>
                <span className="csf-eyebrow">{LC.privacy.eyebrow}</span>
                <h2 className="csf-title">{LC.privacy.title}</h2>
                <p className="csf-lead" style={{ marginTop: 14, fontSize: "var(--text-lg)" }}>{LC.privacy.lead}</p>
              </div>
              <div className="csV4-steps">
                {LC.privacy.steps.map((s, i) => (
                  <Reveal key={s.icon} delay={i * 90} y={12}>
                    <span className="csV4-stepicon"><span className="csf-icon" style={{ fontSize: 24, color: "var(--accent-text)" }}>{s.icon}</span></span>
                    <div style={{ font: "600 17px/1.3 var(--font-ui)", color: "var(--text-primary)", marginTop: 16 }}>{s.title}</div>
                    <p style={{ margin: "6px 0 0", font: "400 15px/1.55 var(--font-ui)", color: "var(--text-secondary)", textWrap: "pretty" }}>{s.body}</p>
                  </Reveal>
                ))}
              </div>
            </div>
          </Reveal>
        </div>
      </section>
    );
  }

  /* ── 4 · Pricing — tier cards + retrieval band ── */
  function SectionV4Pricing() {
    csInjectStyle("v4-pricing-css", `
      .csV4-tiers { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-top: 44px; }
      .csV4-tier { background: var(--surface-card); border: 1px solid var(--border-card); border-radius: 20px; box-shadow: var(--shadow-card); padding: 24px; display: flex; flex-direction: column; gap: 4px; transition: background 150ms var(--ease-out); }
      .csV4-tier:hover { background: var(--surface-hover); }
      .csV4-retrieval { margin-top: 48px; background: var(--surface-raised); border: 1px solid var(--border-subtle); border-radius: 24px; padding: 36px 40px; }
      .csV4-rrows { display: grid; grid-template-columns: repeat(3, 1fr); gap: 24px; margin-top: 28px; }
      .csV4-rrow { border-top: 2px solid var(--border-card); padding-top: 14px; }
      @media (max-width: 960px) { .csV4-tiers { grid-template-columns: repeat(2, 1fr); } }
      @media (max-width: 640px) { .csV4-tiers, .csV4-rrows { grid-template-columns: 1fr; } .csV4-retrieval { padding: 24px; } }
    `);
    return (
      <section id="pricing" className="csf-band" data-screen-label="Pricing" style={{ borderTop: "1px solid var(--border-subtle)" }}>
        <div className="csf-container">
          <div style={{ textAlign: "center", maxWidth: "52ch", margin: "0 auto" }}>
            <span className="csf-eyebrow">{LC.pricing.eyebrow}</span>
            <h2 className="csf-title">{LC.pricing.title}</h2>
            <p className="csf-lead" style={{ marginTop: 14 }}>{LC.pricing.leadNoTabs}</p>
          </div>
          <Reveal y={20}>
            <div className="csV4-tiers">
              {LC.pricing.tiers.map((t) => (
                <div className="csV4-tier" key={t.size}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                    <span className="csf-mono" style={{ font: "500 16px/1 var(--font-mono)", color: "var(--text-secondary)" }}>{t.size}</span>
                    {t.free && <Chip size="sm">no card</Chip>}
                  </div>
                  <div style={{ font: "600 30px/1.15 var(--font-ui)", color: t.free ? "var(--accent-text)" : "var(--text-primary)", marginTop: 10 }}>
                    {t.year}{!t.free && <span style={{ font: "400 15px/1 var(--font-ui)", color: "var(--text-tertiary)" }}> /year</span>}
                  </div>
                  <span className="csf-mono" style={{ font: "400 13px/1.4 var(--font-mono)", color: "var(--text-tertiary)" }}>{t.free ? "forever" : `${t.month} /month`}</span>
                </div>
              ))}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "center", marginTop: 24, textAlign: "center" }}>
              <span style={{ font: "400 15px/1.5 var(--font-ui)", color: "var(--text-secondary)" }}>{LC.pricing.moreLead} <a href="#" style={{ font: "600 15px/1.5 var(--font-ui)", color: "var(--accent-text)", textDecoration: "none" }}>{LC.pricing.moreLink}</a>.</span>
              <span style={{ font: "400 13px/1.5 var(--font-ui)", color: "var(--text-tertiary)" }}>{LC.pricing.renewNote}</span>
            </div>
          </Reveal>
          <Reveal y={20}>
            <div className="csV4-retrieval">
              <div className="csf-split-head">
                <h3 style={{ margin: 0, font: "600 24px/1.2 var(--font-ui)", color: "var(--text-primary)" }}>{LC.pricing.retrievalTitle}</h3>
                <p style={{ margin: 0, font: "400 16px/1.6 var(--font-ui)", color: "var(--text-secondary)", textWrap: "pretty" }}>{LC.pricing.retrievalLead}</p>
              </div>
              <div className="csV4-rrows">
                {LC.pricing.retrievalRows.map((r) => (
                  <div className="csV4-rrow" key={r.label}>
                    <div style={{ font: "600 24px/1.1 var(--font-ui)", color: r.value === "Free" ? "var(--accent-text)" : "var(--text-primary)" }}>{r.value}</div>
                    <div style={{ font: "400 15px/1.4 var(--font-ui)", color: "var(--text-secondary)", marginTop: 6 }}>{r.label}</div>
                  </div>
                ))}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 28, paddingTop: 20, borderTop: "1px solid var(--border-card)" }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 8, font: "400 15px/1.5 var(--font-ui)", color: "var(--text-secondary)" }}>
                  <span className="csf-icon" style={{ fontSize: 18, color: "var(--text-tertiary)" }}>schedule</span>
                  {LC.pricing.readyNote}
                </span>
                <span style={{ display: "inline-flex", alignItems: "flex-start", gap: 8, font: "400 15px/1.55 var(--font-ui)", color: "var(--text-secondary)", textWrap: "pretty" }}>
                  <span className="csf-icon" style={{ fontSize: 18, color: "var(--accent-text)", flexShrink: 0, marginTop: 2 }}>cloud_download</span>
                  <span>{LC.pricing.callout} <a href="#" style={{ font: "600 15px/1 var(--font-ui)", color: "var(--accent-text)", textDecoration: "none", whiteSpace: "nowrap" }}>{LC.pricing.calloutLink}</a></span>
                </span>
                <FinePrint style={{ margin: 0 }}>{LC.pricing.finePrint}</FinePrint>
              </div>
            </div>
          </Reveal>
        </div>
      </section>
    );
  }

  /* ── 5 · FAQ — centered narrow ── */
  function SectionV4Faq() {
    return (
      <section id="faq" className="csf-band" data-screen-label="FAQ" style={{ borderTop: "1px solid var(--border-subtle)" }}>
        <div className="csf-container csf-container--text">
          <div style={{ textAlign: "center", marginBottom: 32 }}>
            <span className="csf-eyebrow">{LC.faq.eyebrow}</span>
            <h2 className="csf-title" style={{ margin: 0 }}>{LC.faq.title}</h2>
          </div>
          <Reveal><Accordion items={LC.faq.items} defaultOpen={0} /></Reveal>
        </div>
      </section>
    );
  }

  /* ── 6 · Close — accent-tinted centered band ── */
  function SectionV4Close() {
    return (
      <section data-screen-label="Closing CTA" style={{ background: "var(--accent-subtle)", borderTop: "1px solid var(--border-subtle)" }}>
        <div className="csf-container csf-band" style={{ textAlign: "center" }}>
          <Reveal>
            <span className="csf-eyebrow">{LC.close.eyebrow}</span>
            <h2 className="csf-title" style={{ margin: 0 }}>{LC.close.title}</h2>
            <p className="csf-lead" style={{ margin: "12px auto 0", maxWidth: "40ch", fontSize: "var(--text-lg)" }}>{LC.close.lead}</p>
            <div style={{ marginTop: 28 }}>
              <Button variant="primary" size="lg" icon="download">{LC.close.cta}</Button>
            </div>
          </Reveal>
        </div>
      </section>
    );
  }

  Object.assign(window, { SectionV4Hero, SectionV4DragIn, SectionV4Privacy, SectionV4Pricing, SectionV4Faq, SectionV4Close });
})();
