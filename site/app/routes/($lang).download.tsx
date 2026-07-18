import type { Route } from "./+types/($lang).download";
import { langUtils } from "~/lib/i18n/i18n-utils.server";
import { DOWNLOAD_DMG_PATH, RELEASES_LATEST_PAGE } from "~/lib/marketing/download";
import { MarketingPage } from "~/components/marketing/marketing-page";
import { PageHero } from "~/components/marketing/sections/page-hero";
import { CtaPanel } from "~/components/ds/cta-panel";
import { Button } from "~/components/ds/button";
import { DOWNLOAD_PAGE } from "~/lib/marketing/content";

/**
 * `/download` — the standalone download page (PROD.md 6c). It serves two arrivals, decided by
 * the `?start=1` search param (see `lib/marketing/download.ts` for which CTA sends which):
 *
 *  - **`?start=1`** — the visitor pressed a button that said "Download", so the file is what
 *    they asked for. A `<meta http-equiv="refresh">` starts it, and the page says so.
 *  - **no param** — the visitor pressed "Get started" / "Choose", which read like navigation.
 *    Nothing is fetched; the page invites them to start it.
 *
 * The manual button is present either way: it's the only control on the no-param path, and
 * the fallback when an auto-start is blocked (some browsers suppress meta-refresh downloads).
 * The param is resolved in the loader so both `meta()` and the component read one decision,
 * and so the auto-start works with JS disabled.
 */
export function meta({ data }: Route.MetaArgs) {
  const base = [
    { title: "ColdStorage — Download for Mac" },
    {
      name: "description",
      content:
        "Download ColdStorage for Mac — free app, macOS 14 or later. Storage from $9.99 a year.",
    },
  ];
  // Only emit the refresh when the visitor actually asked for the file.
  return data?.autoStart
    ? [...base, { httpEquiv: "refresh", content: `1;url=${DOWNLOAD_DMG_PATH}` }]
    : base;
}

export function loader({ params, request }: Route.LoaderArgs) {
  const { lang } = langUtils(params);
  const autoStart = new URL(request.url).searchParams.get("start") === "1";
  return { lang, autoStart };
}

export default function Download({ loaderData }: Route.ComponentProps) {
  const { autoStart } = loaderData;
  const { note, actions } = DOWNLOAD_PAGE;
  return (
    <MarketingPage>
      {/* The head is the standard PageHero, so this page opens the same way every other
          non-landing page does — and it's where the page's one `<h1>` lives. The panel below
          is left with just the buttons rather than repeating the same words in an `<h2>`. */}
      <PageHero
        content={autoStart ? DOWNLOAD_PAGE.started : DOWNLOAD_PAGE.waiting}
        screenLabel="Download"
      />
      <section className="csf-band csf-band--flush-top" data-screen-label="Download">
        <div className="csf-container">
          <CtaPanel note={note}>
            <Button variant="primary" size="lg" icon="download" href={DOWNLOAD_DMG_PATH}>
              {autoStart ? actions.startAgain : actions.start}
            </Button>
            <Button variant="ghost" size="lg" href={RELEASES_LATEST_PAGE}>
              {actions.releases}
            </Button>
          </CtaPanel>
        </div>
      </section>
    </MarketingPage>
  );
}
