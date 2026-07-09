/*
 * LegalPage — the shared prose shell for /terms, /privacy, /refunds. Same page frame as
 * the home route (bg-app → bg-glow → sticky nav → main → footer), with a centered reading
 * measure for long-form legal copy. Content comes from the typed `LegalPageContent` shape in
 * ~/lib/marketing/legal (SSOT); this component only lays it out.
 */
import "./legal-page.css";
import { MarketingNav } from "~/components/marketing/marketing-nav";
import { MarketingFooter } from "~/components/marketing/marketing-footer";
import { FOOTER } from "~/lib/marketing/content";
import { DOWNLOAD_PATH } from "~/lib/marketing/download";
import type { LegalPageContent } from "~/lib/marketing/legal";

/** Nav links jump back to the home page's in-page anchors (full paths, since we're off-home). */
const NAV_LINKS = [
  { label: "How it works", href: "/#how" },
  { label: "Privacy", href: "/#privacy" },
  { label: "Pricing", href: "/#pricing" },
];

export function LegalPage({ title, updated, lede, sections }: LegalPageContent) {
  return (
    <div style={{ background: "var(--bg-app)" }}>
      <div style={{ background: "var(--bg-glow)" }}>
        {/* Off-home page has no hero lip, so the nav is solid from the top. */}
        <MarketingNav links={NAV_LINKS} cta={{ label: "Download for Mac", href: DOWNLOAD_PATH }} solid />
        <main className="csf-legal">
          <div className="csf-container csf-container--text">
            <header className="csf-legal__head">
              <h1 className="csf-legal__title">{title}</h1>
              <p className="csf-legal__updated">Last updated {updated}</p>
              <p className="csf-legal__lede">{lede}</p>
            </header>

            {sections.map((section) => (
              <section key={section.heading} className="csf-legal__section">
                <h2 className="csf-legal__heading">{section.heading}</h2>
                {section.blocks.map((block, i) =>
                  block.kind === "p" ? (
                    <p key={i} className="csf-legal__p">
                      {block.text}
                    </p>
                  ) : (
                    <ul key={i} className="csf-legal__list">
                      {block.items.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  )
                )}
              </section>
            ))}
          </div>
        </main>
        <MarketingFooter
          tagline={FOOTER.tagline}
          columns={FOOTER.columns}
          legal={FOOTER.legal}
          copyright={FOOTER.copyright}
        />
      </div>
    </div>
  );
}
