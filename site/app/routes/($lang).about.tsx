import type { Route } from "./+types/($lang).about";
import { langUtils } from "~/lib/i18n/i18n-utils.server";
import { MarketingPage } from "~/components/marketing/marketing-page";
import { ProsePage } from "~/components/marketing/sections/prose-page";
import { ABOUT_PAGE } from "~/lib/marketing/content";

/**
 * `/about` — who's behind ColdStorage, why it exists, and how it makes money. Linked from the
 * footer's Company column. Copy is `ABOUT_PAGE` in content.ts; the headcount line there is
 * flagged for Ben's confirmation before this ships.
 */
export function meta() {
  return [
    { title: "ColdStorage — About" },
    {
      name: "description",
      content:
        "Why we built ColdStorage, why we can't read your files, and how the business actually makes money.",
    },
  ];
}

export function loader({ params }: Route.LoaderArgs) {
  const { lang } = langUtils(params);
  return { lang };
}

export default function About() {
  return (
    <MarketingPage>
      <ProsePage content={ABOUT_PAGE} />
    </MarketingPage>
  );
}
