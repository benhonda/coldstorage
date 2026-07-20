import type { Route } from "./+types/($lang).brand";
import { langUtils } from "~/lib/i18n/i18n-utils.server";
import { MarketingPage } from "~/components/marketing/marketing-page";
import { PageHero } from "~/components/marketing/sections/page-hero";
import { BrandBoard } from "~/components/marketing/sections/brand-board";
import { BRAND_PAGE } from "~/lib/marketing/content";
import { pageMeta } from "~/lib/marketing/page-meta";

/**
 * `/brand` — the brand board: mark, wordmark, lockups, app icon, palette. A reference page for
 * anyone writing about ColdStorage or building a surface that shows it. Linked from the
 * footer's Company column. Copy is `BRAND_PAGE` in content.ts; the specimens render the real
 * `BrandMark` and the real palette constants, so the page cannot drift from the brand it
 * documents.
 */
export function meta({ params }: Route.MetaArgs) {
  return pageMeta({
    path: "/brand",
    lang: params.lang,
    title: "ColdStorage — Brand",
    description:
      "The ColdStorage logomark, wordmark, lockups, app icon and palette, with the rules for using them.",
  });
}

export function loader({ params }: Route.LoaderArgs) {
  const { lang } = langUtils(params);
  return { lang };
}

export default function Brand() {
  return (
    <MarketingPage>
      <PageHero content={BRAND_PAGE} />
      <BrandBoard />
    </MarketingPage>
  );
}
