import type { Route } from "./+types/($lang).download";
import { langUtils } from "~/lib/i18n/i18n-utils.server";
import { DOWNLOAD_DMG_PATH, RELEASES_LATEST_PAGE } from "~/lib/marketing/download";
import { MarketingPage } from "~/components/marketing/marketing-page";
import { CtaPanel } from "~/components/ds/cta-panel";
import { Button } from "~/components/ds/button";

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
  return (
    <MarketingPage>
      <section className="csf-band" data-screen-label="Download">
        <div className="csf-container">
          <CtaPanel
            eyebrow="ColdStorage for Mac"
            title={autoStart ? "Your download should start shortly" : "Download ColdStorage"}
            lead={
              autoStart
                ? "If it doesn't start on its own, use the button below. Once it lands, open the .dmg and drag ColdStorage into Applications — then open the app and drag in what you want to keep."
                : "Hit the button and the .dmg starts downloading. Open it, drag ColdStorage into Applications, then open the app and drag in what you want to keep — that's the whole setup."
            }
            note="Free app · macOS 14 or later · storage from $9.99 a year"
          >
            <Button variant="primary" size="lg" icon="download" href={DOWNLOAD_DMG_PATH}>
              {autoStart ? "Download again" : "Download for Mac"}
            </Button>
            <Button variant="ghost" size="lg" href={RELEASES_LATEST_PAGE}>
              All releases
            </Button>
          </CtaPanel>
        </div>
      </section>
    </MarketingPage>
  );
}
