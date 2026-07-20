import type { Route } from "./+types/($lang).how-it-works";
import { langUtils } from "~/lib/i18n/i18n-utils.server";
import { MarketingPage } from "~/components/marketing/marketing-page";
import { ProsePage } from "~/components/marketing/sections/prose-page";
import { HOW_PAGE } from "~/lib/marketing/content";
import { pageMeta } from "~/lib/marketing/page-meta";

/**
 * `/how-it-works` — the deep-storage explainer, and the target of the pricing section's
 * "How deep storage works →" link. Copy lives in `HOW_PAGE` in content.ts (the copy SSOT);
 * see the constraints noted there — the backend provider is never named, and this page stays
 * free of dollar figures. Both are enforced by `task copy:check:site`.
 */
export function meta({ params }: Route.MetaArgs) {
  return pageMeta({
    path: "/how-it-works",
    lang: params.lang,
    title: "ColdStorage — How deep storage works",
    description:
      "Why ColdStorage costs so little, what happens when you put files in, and what getting them back actually looks like. Deep storage, explained plainly.",
  });
}

export function loader({ params }: Route.LoaderArgs) {
  const { lang } = langUtils(params);
  return { lang };
}

export default function HowItWorks() {
  return (
    <MarketingPage>
      <ProsePage content={HOW_PAGE} />
    </MarketingPage>
  );
}
