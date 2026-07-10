import type { Route } from "./+types/($lang).download";
import { langUtils } from "~/lib/i18n/i18n-utils.server";
import { useSolidNav } from "~/lib/marketing/site";
import { DOWNLOAD_DMG_PATH, DOWNLOAD_PATH, RELEASES_LATEST_PAGE } from "~/lib/marketing/download";
import { FOOTER } from "~/lib/marketing/content";
import { MarketingNav } from "~/components/marketing/marketing-nav";
import { MarketingFooter } from "~/components/marketing/marketing-footer";
import { CtaPanel } from "~/components/ds/cta-panel";
import { Button } from "~/components/ds/button";

/**
 * `/download` — the standalone download page (PROD.md 6c). Every "Download for Mac" CTA lands
 * here; a meta-refresh auto-starts the actual file via `/download.dmg` (the 302 resource route)
 * a beat after paint, so the visitor reads the install steps while the .dmg arrives — the
 * standard download-page funnel. Works without JS (it's a plain meta refresh), and the
 * "Download again" button covers a blocked/failed auto-start.
 */
export function meta() {
  return [
    { title: "ColdStorage — Download for Mac" },
    { name: "description", content: "Download ColdStorage for Mac and put what you can't lose somewhere else." },
    { httpEquiv: "refresh", content: `1;url=${DOWNLOAD_DMG_PATH}` },
  ];
}

/** Off-home nav links jump back to the home page's in-page anchors (full paths). */
const NAV_LINKS = [
  { label: "How it works", href: "/#how" },
  { label: "Privacy", href: "/#privacy" },
  { label: "Pricing", href: "/pricing" },
];

export function loader({ params }: Route.LoaderArgs) {
  const { lang } = langUtils(params);
  return { lang };
}

export default function Download() {
  const solid = useSolidNav();
  return (
    <div style={{ background: "var(--bg-app)" }}>
      <div style={{ background: "var(--bg-glow)" }}>
        <MarketingNav links={NAV_LINKS} cta={{ label: "Download for Mac", href: DOWNLOAD_PATH }} solid={solid} />
        <main>
          <section className="csf-band" data-screen-label="Download">
            <div className="csf-container">
              <CtaPanel
                eyebrow="ColdStorage for Mac"
                title="Your download is starting"
                lead="When it lands, open the .dmg and drag ColdStorage into Applications. Open the app, sign in, and point it at what matters — that's the whole setup."
                note="Free app · macOS 14 or later · storage from $9.99 a year"
              >
                <Button variant="primary" size="lg" icon="download" href={DOWNLOAD_DMG_PATH}>
                  Download again
                </Button>
                <Button variant="ghost" size="lg" href={RELEASES_LATEST_PAGE}>
                  All releases
                </Button>
              </CtaPanel>
            </div>
          </section>
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
