import type { Route } from "./+types/($lang)._index";
import { langUtils } from "~/lib/i18n/i18n-utils.server";
import { useSolidNav } from "~/lib/marketing/site";
import { DOWNLOAD_PATH } from "~/lib/marketing/download";
import { FOOTER } from "~/lib/marketing/content";
import { MarketingNav } from "~/components/marketing/marketing-nav";
import { MarketingFooter } from "~/components/marketing/marketing-footer";
import { SectionHeroAppMock } from "~/components/marketing/sections/hero-app-mock";
import { SectionHowList } from "~/components/marketing/sections/how-list";
import { SectionPrivacyPrecise } from "~/components/marketing/sections/privacy-precise";
import { SectionPricingStretch } from "~/components/marketing/sections/pricing-stretch";
import { SectionFaqFull } from "~/components/marketing/sections/faq-full";
import { SectionClosingSomewhereElse } from "~/components/marketing/sections/closing-somewhere-else";

/** Nav links — the Master's in-page anchors. */
const NAV_LINKS = [
  { label: "How it works", href: "#how" },
  { label: "Privacy", href: "#privacy" },
  { label: "Pricing", href: "#pricing" },
];

// The ($lang) optional segment carries the language: "/" is English, "/fr" is French.
// fr-only is enforced in langUtils (i18n-utils.server).
// `meta` runs on the client too, so it must NOT import the server-only i18n util
// (`langUtils` lives in `*.server` and would pull server code into the client bundle).
// Derive the language from params inline here; keep `langUtils` to loaders/actions.
export function meta({ params }: Route.MetaArgs) {
  const isFrench = params.lang === "fr";
  return [
    { title: "ColdStorage" },
    {
      name: "description",
      content: isFrench
        ? "Le site marketing de ColdStorage."
        : "The ColdStorage marketing site.",
    },
  ];
}

export function loader({ params }: Route.LoaderArgs) {
  const { lang } = langUtils(params);
  return { lang };
}

export default function Home() {
  // The Master composition: bg-app wrapper → bg-glow inner → sticky nav → the six
  // shipping sections in order → footer. (Ported from `ColdStorage - Master.html`.)
  const solid = useSolidNav();
  return (
    <div style={{ background: "var(--bg-app)" }}>
      <div style={{ background: "var(--bg-glow)" }}>
        <MarketingNav links={NAV_LINKS} cta={{ label: "Download for Mac", href: DOWNLOAD_PATH }} solid={solid} />
        <main>
          <SectionHeroAppMock />
          <SectionHowList />
          <SectionPrivacyPrecise />
          <SectionPricingStretch />
          <SectionFaqFull />
          <SectionClosingSomewhereElse />
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
