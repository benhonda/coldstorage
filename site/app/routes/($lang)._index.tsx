import type { Route } from "./+types/($lang)._index";
import { langUtils } from "~/lib/i18n/i18n-utils.server";
import { MarketingPage } from "~/components/marketing/marketing-page";
import { SectionHeroStatement } from "~/components/marketing/sections/hero-statement";
import { SectionDragIn } from "~/components/marketing/sections/drag-in";
import { SectionPrivacyLedger } from "~/components/marketing/sections/privacy-ledger";
import { SectionPricingTabbed } from "~/components/marketing/sections/pricing-tabbed";
import { SectionFaqSplit } from "~/components/marketing/sections/faq-split";
import { SectionClosingBand } from "~/components/marketing/sections/closing-band";
import { organizationSchema, softwareApplicationSchema } from "~/lib/marketing/structured-data";
import { pageMeta } from "~/lib/marketing/page-meta";

// The ($lang) optional segment carries the language: "/" is English, "/fr" is French.
// fr-only is enforced in langUtils (i18n-utils.server).
// `meta` runs on the client too, so it must NOT import the server-only i18n util
// (`langUtils` lives in `*.server` and would pull server code into the client bundle).
// Derive the language from params inline here; keep `langUtils` to loaders/actions.
export function meta({ params }: Route.MetaArgs) {
  const description = params.lang === "fr"
    ? "ColdStorage sauvegarde vos photos et vos fichiers. Chiffrés sur votre Mac, avec une clé que vous seul détenez. 25 Go gratuits, sans carte."
    : "ColdStorage backs up your photos and files, so a dead laptop or a wiped drive doesn't take them with it. Encrypted on your Mac. Free to start: 25 GB, no card.";

  return pageMeta({
    path: "/",
    lang: params.lang,
    title: "ColdStorage — private, cost-effective backup for Mac",
    description,
    // Entity + product, emitted once on the home page. Their `@id`s are what other pages'
    // nodes reference, so these two live here rather than being repeated site-wide.
    jsonLd: [organizationSchema(), softwareApplicationSchema()],
  });
}

export function loader({ params }: Route.LoaderArgs) {
  const { lang } = langUtils(params);
  return { lang };
}

export default function Home() {
  // The Master composition, in order. (Ported from `ColdStorage - Master.html`.)
  return (
    <MarketingPage>
      <SectionHeroStatement />
      <SectionDragIn />
      <SectionPrivacyLedger />
      <SectionPricingTabbed />
      <SectionFaqSplit />
      <SectionClosingBand />
    </MarketingPage>
  );
}
