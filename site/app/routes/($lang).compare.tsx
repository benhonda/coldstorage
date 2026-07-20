import type { Route } from "./+types/($lang).compare";
import { langUtils } from "~/lib/i18n/i18n-utils.server";
import { MarketingPage } from "~/components/marketing/marketing-page";
import { ComparePage } from "~/components/marketing/sections/compare-page";
import { COMPARE_PAGE } from "~/lib/marketing/content";
import { pageMeta } from "~/lib/marketing/page-meta";

/**
 * `/compare` — how ColdStorage stacks up against instant-access cloud storage.
 *
 * Copy lives in `COMPARE_PAGE` in content.ts; its page-specific constraints (one verified
 * competitor figure, concede where they're better, never anti-cloud) are documented there and
 * partly enforced by `task copy:check:site`.
 *
 * Ships the table as JSON-LD too. The rows are already in the DOM as a real `<table>`, so the
 * structured data describes what's actually rendered rather than a parallel claim — same
 * discipline `/faq` follows.
 */
export function meta({ params }: Route.MetaArgs) {
  return pageMeta({
    path: "/compare",
    lang: params.lang,
    title: "ColdStorage vs. instant-access cloud storage",
    description:
      "ColdStorage keeps files resting instead of live: 2 TB costs $36.99 a year against $119.88 for iCloud+, files come back in about 48 hours, and only you hold the key. An honest comparison, including where instant access is the better tool.",
    og: {
      description:
        "Two tiers of the same category. What each one costs, what you give up, and when you should stay where you are.",
    },
    jsonLd: [
      {
        "@context": "https://schema.org",
        "@type": "Table",
        about: "Comparison of ColdStorage and instant-access cloud storage",
        name: COMPARE_PAGE.title,
      },
    ],
  });
}

export function loader({ params }: Route.LoaderArgs) {
  const { lang } = langUtils(params);
  return { lang };
}

export default function Compare() {
  return (
    <MarketingPage>
      <ComparePage />
    </MarketingPage>
  );
}
