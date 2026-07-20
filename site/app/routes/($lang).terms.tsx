import type { Route } from "./+types/($lang).terms";
import { langUtils } from "~/lib/i18n/i18n-utils.server";
import { LegalPage } from "~/components/marketing/legal-page";
import { TERMS_PAGE } from "~/lib/marketing/legal";
import { pageMeta } from "~/lib/marketing/page-meta";

export function meta({ params }: Route.MetaArgs) {
  return pageMeta({
    path: "/terms",
    lang: params.lang,
    title: "ColdStorage — Terms of Service",
    description:
      "The terms covering your ColdStorage account and storage plan — what we provide, what renewal and cancellation look like, and the limits of both.",
  });
}

export function loader({ params }: Route.LoaderArgs) {
  const { lang } = langUtils(params);
  return { lang };
}

export default function Terms() {
  return <LegalPage {...TERMS_PAGE} />;
}
