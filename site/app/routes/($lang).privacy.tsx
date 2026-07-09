import type { Route } from "./+types/($lang).privacy";
import { langUtils } from "~/lib/i18n/i18n-utils.server";
import { LegalPage } from "~/components/marketing/legal-page";
import { PRIVACY_PAGE } from "~/lib/marketing/legal";

export function meta() {
  return [{ title: "ColdStorage — Privacy Policy" }];
}

export function loader({ params }: Route.LoaderArgs) {
  const { lang } = langUtils(params);
  return { lang };
}

export default function Privacy() {
  return <LegalPage {...PRIVACY_PAGE} />;
}
