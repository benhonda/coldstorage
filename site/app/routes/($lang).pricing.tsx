import type { Route } from "./+types/($lang).pricing";
import { langUtils } from "~/lib/i18n/i18n-utils.server";
import { MarketingPage } from "~/components/marketing/marketing-page";
import { PageHero } from "~/components/marketing/sections/page-hero";
import { SectionPricingTabbed } from "~/components/marketing/sections/pricing-tabbed";
import { PRICING_PAGE } from "~/lib/marketing/content";
import { SectionClosingBand } from "~/components/marketing/sections/closing-band";

/**
 * `/pricing` — a canonical, standalone pricing page (the same section the home page shows at
 * #pricing, on its own stable URL). Paddle's domain review wants a clear pricing URL, and
 * review tooling doesn't reliably follow `#anchor` fragments — so this exists as a real route.
 */
export function meta() {
  return [
    { title: "ColdStorage — Pricing" },
    {
      name: "description",
      content:
        "ColdStorage storage plans — priced by size. Start with 25 GB free, no card; paid sizes from $9.99 a year. Getting files back is passed through at cost.",
    },
  ];
}

export function loader({ params }: Route.LoaderArgs) {
  const { lang } = langUtils(params);
  return { lang };
}

export default function Pricing() {
  return (
    <MarketingPage>
      <PageHero content={PRICING_PAGE} />
      {/* The hero carries the eyebrow, title and lead — the section head would repeat all three. */}
      <SectionPricingTabbed showHead={false} />
      <SectionClosingBand />
    </MarketingPage>
  );
}
