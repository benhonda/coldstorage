import type { Route } from "./+types/($lang).help";
import { langUtils } from "~/lib/i18n/i18n-utils.server";
import { MarketingPage } from "~/components/marketing/marketing-page";
import { PageHero } from "~/components/marketing/sections/page-hero";
import {
  SectionHelpGroups,
  SectionHelpContact,
} from "~/components/marketing/sections/help-center";
import { HELP_PAGE } from "~/lib/marketing/content";
import { pageMeta } from "~/lib/marketing/page-meta";

/**
 * `/help` — the help center, linked from the footer's Support column. Longer answers than
 * `/faq` gives: `/faq` is still selling, this one assumes you've already got the app.
 *
 * No FAQPage JSON-LD here on purpose — `/faq` already carries it, and two competing FAQPage
 * blocks on one domain is worse for search than one clear one.
 */
export function meta({ params }: Route.MetaArgs) {
  return pageMeta({
    path: "/help",
    lang: params.lang,
    title: "ColdStorage — Help center",
    description:
      "How to install ColdStorage, what the recovery code is for, how to put files in, and what getting them back costs and takes.",
  });
}

export function loader({ params }: Route.LoaderArgs) {
  const { lang } = langUtils(params);
  return { lang };
}

export default function Help() {
  return (
    <MarketingPage>
      <PageHero content={HELP_PAGE} screenLabel="Help center" />
      <SectionHelpGroups />
      <SectionHelpContact />
    </MarketingPage>
  );
}
