import type { Route } from "./+types/($lang).refunds";
import { langUtils } from "~/lib/i18n/i18n-utils.server";
import { LegalPage } from "~/components/marketing/legal-page";
import { REFUND_PAGE } from "~/lib/marketing/legal";

export function meta() {
  return [{ title: "ColdStorage — Refund Policy" }];
}

export function loader({ params }: Route.LoaderArgs) {
  const { lang } = langUtils(params);
  return { lang };
}

export default function Refunds() {
  return <LegalPage {...REFUND_PAGE} />;
}
