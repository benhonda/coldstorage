import type { Route } from "./+types/($lang).privacy";
import { langUtils } from "~/lib/i18n/i18n-utils.server";
import { LegalPage } from "~/components/marketing/legal-page";
import { PRIVACY_PAGE } from "~/lib/marketing/legal";
import { pageMeta } from "~/lib/marketing/page-meta";

export function meta({ params }: Route.MetaArgs) {
  return pageMeta({
    path: "/privacy",
    lang: params.lang,
    title: "ColdStorage — Privacy Policy",
    description:
      "How ColdStorage handles your data: what we collect, what we can't see, who processes payments, and how to get in touch about any of it.",
  });
}

export function loader({ params }: Route.LoaderArgs) {
  const { lang } = langUtils(params);
  return { lang };
}

export default function Privacy() {
  return <LegalPage {...PRIVACY_PAGE} />;
}
