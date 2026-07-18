import type { Route } from "./+types/($lang).faq";
import { langUtils } from "~/lib/i18n/i18n-utils.server";
import { FAQ } from "~/lib/marketing/content";
import { MarketingPage } from "~/components/marketing/marketing-page";
import { SectionFaqSplit } from "~/components/marketing/sections/faq-split";
import { SectionClosingBand } from "~/components/marketing/sections/closing-band";

/**
 * `/faq` — the questions on their own URL. Renders the same `SectionFaqSplit` the home page
 * does, so the two can't drift; the copy doc calls for "a real, SEO-worthy section", and a
 * stable URL is most of what makes it one.
 *
 * The FAQ ships as JSON-LD too: every answer is already in the DOM (the accordion collapses
 * rather than unmounts), so the structured data describes what's actually on the page.
 */
export function meta() {
  return [
    { title: "ColdStorage — Questions" },
    {
      name: "description",
      content:
        "Common questions about ColdStorage: how it differs from iCloud and Dropbox, whether we can read your files, what a recovery costs, and how to get everything back out.",
    },
    {
      "script:ld+json": {
        "@context": "https://schema.org",
        "@type": "FAQPage",
        mainEntity: FAQ.items.map((it) => ({
          "@type": "Question",
          name: it.question,
          acceptedAnswer: { "@type": "Answer", text: it.answer },
        })),
      },
    },
  ];
}

export function loader({ params }: Route.LoaderArgs) {
  const { lang } = langUtils(params);
  return { lang };
}

export default function Faq() {
  return (
    <MarketingPage>
      <SectionFaqSplit />
      <SectionClosingBand />
    </MarketingPage>
  );
}
