/* Contained, text-only page-hero sections — reusable on any page.
   Each takes { eyebrow, title, lead } so copy can swap freely. */
(function () {
  csInjectStyle("ph-css", `
    .ph-wrap { background: var(--bg-app); color: var(--text-primary); font-family: var(--font-ui); height: 100%; display: flex; align-items: center; }
    .ph-band { width: 100%; padding: 72px 0; background: var(--bg-glow); }
    .ph-h1 { margin: 0; font: var(--type-headline); letter-spacing: var(--tracking-tighter); text-wrap: balance; }
    .ph-lead { margin: 18px 0 0; font: var(--type-lead); color: var(--text-secondary); text-wrap: pretty; max-width: 54ch; }
    .ph-eyebrow { display: block; margin-bottom: 16px; }
  `);

  /* A · Centered stack */
  function PhCentered({ eyebrow, title, lead }) {
    return (
      <div className="ph-wrap"><section className="ph-band"><div className="csf-container" style={{ textAlign: "center" }}>
        <span className="csf-eyebrow ph-eyebrow">{eyebrow}</span>
        <h1 className="ph-h1" style={{ maxWidth: "22ch", margin: "0 auto" }}>{title}</h1>
        <p className="ph-lead" style={{ margin: "18px auto 0", maxWidth: "48ch" }}>{lead}</p>
      </div></section></div>
    );
  }

  /* B · Left-aligned stack */
  function PhLeft({ eyebrow, title, lead }) {
    return (
      <div className="ph-wrap"><section className="ph-band"><div className="csf-container">
        <span className="csf-eyebrow ph-eyebrow">{eyebrow}</span>
        <h1 className="ph-h1" style={{ maxWidth: "24ch" }}>{title}</h1>
        <p className="ph-lead">{lead}</p>
      </div></section></div>
    );
  }

  /* C · Split head — title left, lead right */
  function PhSplit({ eyebrow, title, lead }) {
    return (
      <div className="ph-wrap"><section className="ph-band"><div className="csf-container" style={{ display: "grid", gridTemplateColumns: "1.1fr 1fr", gap: 64, alignItems: "end" }}>
        <div>
          <span className="csf-eyebrow ph-eyebrow">{eyebrow}</span>
          <h1 className="ph-h1">{title}</h1>
        </div>
        <p className="ph-lead" style={{ margin: 0 }}>{lead}</p>
      </div></section></div>
    );
  }

  Object.assign(window, { PhCentered, PhLeft, PhSplit });
})();
