import type { Route } from "./+types/($lang).pricing";
import { langUtils } from "~/lib/i18n/i18n-utils.server";
import { useSolidNav } from "~/lib/marketing/site";
import { DOWNLOAD_PATH } from "~/lib/marketing/download";
import { FOOTER } from "~/lib/marketing/content";
import { MarketingNav } from "~/components/marketing/marketing-nav";
import { MarketingFooter } from "~/components/marketing/marketing-footer";
import { SectionPricingStretch } from "~/components/marketing/sections/pricing-stretch";

/**
 * `/pricing` — a canonical, standalone pricing page (the same section the home page shows at
 * #pricing, on its own stable URL). Paddle's domain review wants a clear pricing URL, and
 * review tooling doesn't reliably follow `#anchor` fragments — so this exists as a real route.
 */
export function meta() {
  return [
    { title: "ColdStorage — Pricing" },
    { name: "description", content: "ColdStorage storage plans — priced by size, from $9.99 a year." },
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

export default function Pricing() {
  const solid = useSolidNav();
  return (
    <div style={{ background: "var(--bg-app)" }}>
      <div style={{ background: "var(--bg-glow)" }}>
        <MarketingNav links={NAV_LINKS} cta={{ label: "Download for Mac", href: DOWNLOAD_PATH }} solid={solid} />
        <main>
          <SectionPricingStretch />
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
