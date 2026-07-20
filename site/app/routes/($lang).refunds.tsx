import type { Route } from "./+types/($lang).refunds";
import { langUtils } from "~/lib/i18n/i18n-utils.server";
import { LegalPage } from "~/components/marketing/legal-page";
import { REFUND_PAGE } from "~/lib/marketing/legal";
import { pageMeta } from "~/lib/marketing/page-meta";

export function meta({ params }: Route.MetaArgs) {
  return pageMeta({
    path: "/refunds",
    lang: params.lang,
    title: "ColdStorage — Refund Policy",
    description:
      "When a ColdStorage plan can be refunded, how to ask for one, and how refunds work on an annual plan that renews automatically.",
  });
}

export function loader({ params }: Route.LoaderArgs) {
  const { lang } = langUtils(params);
  return { lang };
}

export default function Refunds() {
  return <LegalPage {...REFUND_PAGE} />;
}
