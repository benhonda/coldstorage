/*
 * Section · PageHero — the standard head for every page that isn't the landing page.
 *
 * Ported from `Claude design · page-heroes.jsx`, which ships three variants of the
 * same contained, text-only header (A centered · B left · C split). We standardised on
 * **B · left-aligned**: it matches the reading flow of the prose, help and FAQ pages that sit
 * beneath it, and it holds up across titles and leads of very different lengths — which a
 * centered or split head does not.
 *
 * It replaces three near-identical hand-rolled heads (ProseHead, SectionHelpHead, and the
 * inline head in contact-form) plus their three duplicated stylesheets, and it gives `/faq`,
 * `/pricing` and `/download` the `<h1>` they were shipping without.
 *
 * Typography comes from the `csf-headline` / `csf-lead` utilities, which already encode the
 * exact `--type-headline` / `--type-lead` rules the upstream `.ph-h1` / `.ph-lead` declare —
 * so the only thing this component's own stylesheet owns is layout (measure and rhythm).
 *
 * Note the band deliberately does NOT re-apply `--bg-glow` the way upstream's `.ph-band` does:
 * that's the preview shell reproducing page context, and `MarketingPage` already lays the glow
 * across the whole page. Re-applying it would stack a second gradient on top of the first.
 */
import "./page-hero.css";
import { Reveal } from "~/lib/marketing/motion";
import type { PageHeadContent } from "~/lib/marketing/content";

export type PageHeroProps = {
  content: PageHeadContent;
  /**
   * Overrides the section's screen label, which otherwise reads as the eyebrow. Worth setting
   * when the eyebrow is a category ("Support") but the page is a thing ("Help center").
   */
  screenLabel?: string;
};

export function PageHero({ content, screenLabel }: PageHeroProps) {
  return (
    <section className="cs-page-hero" data-screen-label={screenLabel ?? content.eyebrow}>
      <div className="csf-container">
        <span className="csf-eyebrow cs-page-hero__eyebrow">{content.eyebrow}</span>
        <h1 className="csf-headline cs-page-hero__title">{content.title}</h1>
        <Reveal delay={120}>
          <p className="csf-lead cs-page-hero__lead">{content.intro}</p>
        </Reveal>
      </div>
    </section>
  );
}
