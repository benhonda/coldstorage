/*
 * LegalPage — the shared prose shell for /terms, /privacy, /refunds. Wears the standard
 * MarketingPage chrome (so it can't drift from the nav/footer every other page shows), with
 * a centered reading measure for long-form legal copy. Content comes from the typed
 * `LegalPageContent` shape in ~/lib/marketing/legal (SSOT); this component only lays it out.
 */
import "./legal-page.css";
import { MarketingPage } from "~/components/marketing/marketing-page";
import type { LegalPageContent } from "~/lib/marketing/legal";

export function LegalPage({ title, updated, lede, sections }: LegalPageContent) {
  return (
    // No hero lip here for a transparent bar to sit over, so the nav is solid from the top.
    <MarketingPage forceSolid mainClassName="csf-legal">
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
    </MarketingPage>
  );
}
