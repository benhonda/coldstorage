import type { Route } from "./+types/($lang).source";
import { langUtils } from "~/lib/i18n/i18n-utils.server";
import { MarketingPage } from "~/components/marketing/marketing-page";
import { ProsePage } from "~/components/marketing/sections/prose-page";
import { OPEN_SOURCE_PAGE, REPO_URL } from "~/lib/marketing/content";

/**
 * `/source` — the "don't take our word for it" page. Its whole job is to point at the two
 * files where the encryption claim is either true or it isn't, so the CTA goes to GitHub
 * rather than to a download.
 *
 * The route is `/source`, not `/open-source`: the repo ships under the Functional Source
 * License, which is source-available and NOT open source, so an `/open-source` URL would
 * misstate the very thing this page exists to be honest about. Copy is `OPEN_SOURCE_PAGE` in
 * content.ts — the export kept its name; the URL and the words are what changed.
 */
export function meta() {
  return [
    { title: "ColdStorage — Source code" },
    {
      name: "description",
      content:
        "All of ColdStorage is on GitHub, including the encryption. Check the claims yourself instead of taking our word for them.",
    },
  ];
}

export function loader({ params }: Route.LoaderArgs) {
  const { lang } = langUtils(params);
  return { lang };
}

export default function Source() {
  return (
    <MarketingPage>
      <ProsePage content={OPEN_SOURCE_PAGE} ctaHref={REPO_URL} ctaIcon="code" />
    </MarketingPage>
  );
}
