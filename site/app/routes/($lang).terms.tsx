import type { Route } from "./+types/($lang).terms";
import { langUtils } from "~/lib/i18n/i18n-utils.server";
import { LegalPage } from "~/components/marketing/legal-page";
import { TERMS_PAGE } from "~/lib/marketing/legal";

export function meta() {
  return [{ title: "ColdStorage — Terms of Service" }];
}

export function loader({ params }: Route.LoaderArgs) {
  const { lang } = langUtils(params);
  return { lang };
}

export default function Terms() {
  return <LegalPage {...TERMS_PAGE} />;
}
