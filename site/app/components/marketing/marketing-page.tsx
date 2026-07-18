/*
 * MarketingPage — the shared chrome every marketing route wears: the `bg-app` → `bg-glow`
 * wrapper, the sticky nav, a <main>, and the footer. Routes supply only their sections.
 *
 * This exists because five routes (`/`, `/pricing`, `/faq`, `/how-it-works`, `/download`) had
 * hand-copied the same wrapper, which is how a nav link ends up updated in four places and
 * stale in the fifth.
 */
import { useSolidNav } from "~/lib/marketing/site";
import { DOWNLOAD_START_PATH } from "~/lib/marketing/download";
import { FOOTER, HERO, NAV_LINKS } from "~/lib/marketing/content";
import { MarketingNav } from "~/components/marketing/marketing-nav";
import { MarketingFooter } from "~/components/marketing/marketing-footer";
import type * as React from "react";

export type MarketingPageProps = {
  children: React.ReactNode;
  /**
   * Where the nav's CTA points. Defaults to the auto-start download, which is right for every
   * page — the CTA reads "Download for Mac", and a button that says download should download.
   */
  ctaHref?: string;
  /**
   * Force the nav's solid/frosted treatment from the top, instead of waiting for scroll.
   * For pages with no hero lip for a transparent bar to sit over (the legal prose pages).
   */
  forceSolid?: boolean;
  /** Class for the <main> element — long-form pages need their own reading measure. */
  mainClassName?: string;
};

export function MarketingPage({
  children,
  ctaHref = DOWNLOAD_START_PATH,
  forceSolid = false,
  mainClassName,
}: MarketingPageProps) {
  const scrolled = useSolidNav();
  return (
    <div style={{ background: "var(--bg-app)" }}>
      <div style={{ background: "var(--bg-glow)" }}>
        <MarketingNav
          links={NAV_LINKS}
          cta={{ label: HERO.cta, href: ctaHref }}
          solid={forceSolid || scrolled}
        />
        <main className={mainClassName}>{children}</main>
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
