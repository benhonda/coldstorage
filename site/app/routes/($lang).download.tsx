import type { Route } from "./+types/($lang).download";
import { langUtils } from "~/lib/i18n/i18n-utils.server";
import { pageMeta } from "~/lib/marketing/page-meta";
import { DOWNLOAD_DMG_PATH, RELEASES_PATH } from "~/lib/marketing/download";
import { MarketingPage } from "~/components/marketing/marketing-page";
import { PageHero } from "~/components/marketing/sections/page-hero";
import { CtaPanel } from "~/components/ds/cta-panel";
import { ArchNotice, useIntelMacDetection } from "~/components/marketing/arch-notice";
import { Button } from "~/components/ds/button";
import { DOWNLOAD_PAGE } from "~/lib/marketing/content";

/**
 * `/download` — the standalone download page (PROD.md 6c). Every CTA on the site lands here,
 * and NOTHING downloads until the visitor presses the button below — no auto-start, ever
 * (Ben's call, 2026-07-28; also how Screen Studio's page behaves). The release is arm64-only,
 * so the page states the requirement in the note line for everyone, and shows a warn-only
 * banner when the browser positively identifies an Intel Mac. The button itself is never
 * hidden or disabled — detection can be wrong, and the notice says so.
 */
export function meta({ params }: Route.MetaArgs) {
  return pageMeta({
    path: "/download",
    lang: params.lang,
    title: "ColdStorage — Download for Mac",
    description:
      "Download ColdStorage for Mac — free app for Apple silicon Macs, macOS 14 or later. Storage from $9.99 a year.",
  });
}

export function loader({ params }: Route.LoaderArgs) {
  const { lang } = langUtils(params);
  return { lang };
}

export default function Download() {
  const { head, note, actions } = DOWNLOAD_PAGE;
  const isIntelMac = useIntelMacDetection();
  return (
    <MarketingPage>
      {/* The head is the standard PageHero, so this page opens the same way every other
          non-landing page does — and it's where the page's one `<h1>` lives. The panel below
          is left with just the buttons rather than repeating the same words in an `<h2>`. */}
      <PageHero content={head} screenLabel="Download" />
      <section className="csf-band csf-band--flush-top" data-screen-label="Download">
        <div className="csf-container">
          {/* Warn-only: appears only when the browser positively reports an Intel Mac. */}
          <ArchNotice isIntelMac={isIntelMac} />
          <CtaPanel note={note}>
            <Button variant="primary" size="lg" icon="download" href={DOWNLOAD_DMG_PATH}>
              {actions.start}
            </Button>
            <Button variant="ghost" size="lg" href={RELEASES_PATH}>
              {actions.releases}
            </Button>
          </CtaPanel>
        </div>
      </section>
    </MarketingPage>
  );
}
