/* Master concept — pricing (Concept 3's design, organized into tabs, CTA buttons on rows)
   and FAQ (Concept 3 split layout, accordion in a white card). */
(function () {
  const { Button, Chip, SegmentedControl, Accordion } = window.ColdstorageDesignSystem_41ebaf;

  /* ── Pricing — Concept 3 cards, tabbed ── */
  function SectionMPricing() {
    csInjectStyle("m-pricing-css", `
      .csM-tabs { display: flex; gap: 8px; margin: 40px auto 24px; flex-wrap: wrap; justify-content: center; }
      .csM-tabbtn { display: flex; flex-direction: column; gap: 3px; text-align: left; border: 1px solid var(--border-subtle); background: var(--surface-card); border-radius: 18px; padding: 14px 22px; min-width: 220px; cursor: pointer; font-family: var(--font-ui); transition: background 150ms var(--ease-out), border-color 150ms var(--ease-out); }
      .csM-tabbtn:hover { background: var(--surface-hover); }
      .csM-tabbtn[data-active="true"] { background: var(--accent-subtle); border-color: transparent; }
      .csM-tabbtn .t { font: 600 16px/1.3 var(--font-ui); color: var(--text-primary); }
      .csM-tabbtn[data-active="true"] .t { color: var(--accent-text); }
      .csM-tabbtn .s { font: 400 13px/1.4 var(--font-ui); color: var(--text-tertiary); }
      .csM-panel { animation: csM-fade 320ms ${CS_EASE}; max-width: 760px; margin: 0 auto; }
      @keyframes csM-fade { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
      .csM-card { background: var(--surface-card); border: 1px solid var(--border-card); border-radius: 24px; box-shadow: var(--shadow-card); padding: 24px; }
      .csM-cardlabel { font: 400 13px/1 var(--font-ui); color: var(--text-tertiary); text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 8px; }
      .csM-table { width: 100%; border-collapse: separate; border-spacing: 0; }
      .csM-table th { font: 400 13px/1 var(--font-ui); color: var(--text-tertiary); text-align: left; padding: 12px 12px 10px; }
      .csM-table td { padding: 0 12px; height: 64px; transition: background 150ms var(--ease-out); }
      .csM-table td:first-child { border-radius: 14px 0 0 14px; }
      .csM-table td:last-child { border-radius: 0 14px 14px 0; }
      .csM-table tbody tr:hover td { background: var(--surface-hover); }
      .csM-numcol { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
      .csM-ctacol { text-align: right; white-space: nowrap; padding-left: 24px; }
      .csM-krow { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 18px 4px; border-top: 1px solid var(--border-subtle); }
      .csM-krow:first-of-type { border-top: 0; }
      .csM-retrieval { display: flex; flex-direction: column; gap: 16px; }
      @media (max-width: 720px) { .csM-card { padding: 16px; } .csM-table td, .csM-table th { padding-left: 8px; padding-right: 8px; } .csM-table th:last-child { display: none; } }
    `);
    const [tab, setTab] = React.useState("storage");
    const NAV = [
      { value: "storage", label: "Storage", sub: "Yearly plans by size" },
      { value: "retrieval", label: "Getting files back", sub: "What a recovery costs" },
    ];
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
            <div className="csM-tabs" role="tablist">
              {NAV.map((n) => (
                <button key={n.value} role="tab" aria-selected={tab === n.value} className="csM-tabbtn" data-active={tab === n.value ? "true" : "false"} onClick={() => setTab(n.value)}>
                  <span className="t">{n.label}</span>
                  <span className="s">{n.sub}</span>
                </button>
              ))}
            </div>
            <div className="csM-panel" key={tab}>
              {tab === "storage" ? <MPricingStorage /> : <MPricingRetrieval />}
            </div>
          </Reveal>
        </div>
      </section>
    );
  }

  function MPricingStorage() {
    return (
      <div className="csM-card">
        <table className="csM-table">
          <thead>
            <tr><th>Size</th><th className="csM-numcol">Per year</th><th className="csM-numcol">Per month</th><th></th></tr>
          </thead>
          <tbody>
            {LC.pricing.tiers.map((t) => (
              <tr key={t.size}>
                <td>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 12 }}>
                    <span className="csf-mono" style={{ font: "500 16px/1 var(--font-mono)", color: "var(--text-primary)", whiteSpace: "nowrap" }}>{t.size}</span>
                    {t.free && <Chip size="sm">free · no card</Chip>}
                  </span>
                </td>
                <td className="csM-numcol" style={{ font: "600 17px/1 var(--font-ui)", color: t.free ? "var(--accent-text)" : "var(--text-primary)" }}>{t.year}</td>
                <td className="csM-numcol csf-mono" style={{ font: "400 14px/1 var(--font-mono)", color: "var(--text-tertiary)" }}>{t.month}</td>
                <td className="csM-ctacol">
                  <Button variant={t.free ? "primary" : "secondary"} size="sm">{t.free ? "Get started" : "Choose"}</Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "18px 12px 0" }}>
          <span style={{ font: "400 15px/1.5 var(--font-ui)", color: "var(--text-secondary)" }}>{LC.pricing.moreLead} <a href="#" style={{ font: "600 15px/1.5 var(--font-ui)", color: "var(--accent-text)", textDecoration: "none" }}>{LC.pricing.moreLink}</a>.</span>
          <span style={{ font: "400 13px/1.5 var(--font-ui)", color: "var(--text-tertiary)" }}>{LC.pricing.renewNote}</span>
        </div>
      </div>
    );
  }

  function MPricingRetrieval() {
    return (
      <div className="csM-retrieval">
        <div className="csM-card">
          <p style={{ margin: "4px 0 8px", font: "400 15px/1.55 var(--font-ui)", color: "var(--text-secondary)", textWrap: "pretty" }}>{LC.pricing.retrievalLead}</p>
          {LC.pricing.retrievalRows.map((r) => (
            <div className="csM-krow" key={r.label}>
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
    );
  }

  /* ── FAQ — Concept 3 split, accordion in a white card ── */
  function SectionMFaq() {
    csInjectStyle("m-faq-css", `
      .csM-faq { display: grid; grid-template-columns: 1fr 1.6fr; gap: 64px; align-items: start; }
      .csM-faqcard { background: var(--surface-card); border: 1px solid var(--border-card); border-radius: 24px; box-shadow: var(--shadow-card); padding: 12px 24px; }
      @media (max-width: 880px) { .csM-faq { grid-template-columns: 1fr; gap: 24px; } .csM-faqcard { padding: 8px 16px; } }
    `);
    return (
      <section id="faq" className="csf-band" data-screen-label="FAQ" style={{ borderTop: "1px solid var(--border-subtle)" }}>
        <div className="csf-container">
          <div className="csM-faq">
            <div>
              <span className="csf-eyebrow">{LC.faq.eyebrow}</span>
              <h2 className="csf-title">{LC.faq.title}</h2>
            </div>
            <Reveal>
              <div className="csM-faqcard">
                <Accordion items={LC.faq.items} defaultOpen={0} />
              </div>
            </Reveal>
          </div>
        </div>
      </section>
    );
  }

  Object.assign(window, { SectionMPricing, SectionMFaq });
})();
