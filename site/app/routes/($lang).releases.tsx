import { data } from "react-router";
import type { Route } from "./+types/($lang).releases";
import { langUtils } from "~/lib/i18n/i18n-utils.server";
import { pageMeta } from "~/lib/marketing/page-meta";
import { RELEASE_REPO, RELEASES_LATEST_PAGE } from "~/lib/marketing/download";
import { MarketingPage } from "~/components/marketing/marketing-page";
import { PageHero } from "~/components/marketing/sections/page-hero";
import { ReleasesList, type ReleaseRow } from "~/components/marketing/sections/releases-list";
import { Button } from "~/components/ds/button";
import { RELEASES_PAGE } from "~/lib/marketing/content";
import { logError } from "~/lib/logger";

/** Shape of the bits of the GitHub "list releases" payload we read. */
type GithubAsset = { name: string; browser_download_url: string; size: number };
type GithubRelease = {
  tag_name: string;
  published_at: string;
  body: string | null;
  draft: boolean;
  prerelease: boolean;
  assets: GithubAsset[];
};

/**
 * Release bodies double as this page's release notes — but every body published so far is
 * the release task's own reminder text, not notes for a human. Treat that boilerplate as
 * "no notes" so it never renders on the site; real notes written on a release will appear.
 */
function cleanNotes(body: string | null): string | null {
  const trimmed = body?.trim() ?? "";
  if (!trimmed || trimmed.startsWith("Draft — assets uploaded by electron-builder")) return null;
  return trimmed;
}

/**
 * `/releases` — the on-site version archive ("All releases" on `/download` lands here).
 * Same source of truth as the `/download.dmg` resolver: the GitHub Releases API, read
 * server-side and edge-cached hourly, so nothing is hand-maintained per release and the
 * visitor never has to leave the site for raw GitHub. Rows are pre-formatted in the loader
 * (dates, sizes) so the page ships no client JS for this.
 *
 * If the API can't be reached the page says so and links to GitHub — a shorter-lived cache
 * on that path (60s) lets it recover quickly instead of pinning an empty list for an hour.
 */
export function meta({ params }: Route.MetaArgs) {
  return pageMeta({
    path: "/releases",
    lang: params.lang,
    title: "ColdStorage — All releases",
    description:
      "Every ColdStorage for Mac release, newest first — download the latest or any earlier build.",
  });
}

export function headers({ loaderHeaders }: Route.HeadersArgs) {
  return loaderHeaders;
}

export async function loader({ params }: Route.LoaderArgs) {
  const { lang } = langUtils(params);
  try {
    const res = await fetch(
      `https://api.github.com/repos/${RELEASE_REPO.owner}/${RELEASE_REPO.repo}/releases?per_page=50`,
      { headers: { Accept: "application/vnd.github+json" } }
    );
    if (!res.ok) throw new Error(`GitHub releases API responded ${res.status}`);

    const payload = (await res.json()) as GithubRelease[];
    const releases: ReleaseRow[] = payload
      .filter((r) => !r.draft && !r.prerelease)
      .flatMap((r) => {
        // A release without a .dmg isn't downloadable by a visitor — skip it entirely.
        const dmg = r.assets.find((a) => a.name.toLowerCase().endsWith(".dmg"));
        if (!dmg) return [];
        return [
          {
            version: r.tag_name,
            date: new Date(r.published_at).toLocaleDateString("en-US", {
              year: "numeric",
              month: "long",
              day: "numeric",
            }),
            size: `${Math.round(dmg.size / 1e6)} MB`,
            dmgUrl: dmg.browser_download_url,
            notes: cleanNotes(r.body),
          },
        ];
      });
    if (releases.length === 0) throw new Error("no published releases with a .dmg asset");

    return data(
      { lang, releases },
      // Same edge policy as the .dmg resolver: revalidate hourly, serve stale meanwhile.
      { headers: { "Cache-Control": "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400" } }
    );
  } catch (err) {
    logError("releases: could not load the release list from GitHub", err);
    return data(
      { lang, releases: null },
      // Short cache on the failure state so the page recovers once the API is healthy.
      { headers: { "Cache-Control": "public, max-age=0, s-maxage=60" } }
    );
  }
}

export default function Releases({ loaderData }: Route.ComponentProps) {
  const { releases } = loaderData;
  return (
    <MarketingPage>
      <PageHero content={RELEASES_PAGE.head} screenLabel="Releases" />
      <section className="csf-band csf-band--flush-top" data-screen-label="Releases">
        <div className="csf-container">
          {releases ? (
            <ReleasesList releases={releases} />
          ) : (
            /* The API is down: say so plainly and hand over the one link that still works. */
            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 20 }}>
              <p className="csf-lead" style={{ maxWidth: "55ch" }}>
                {RELEASES_PAGE.unavailable}
              </p>
              <Button variant="ghost" size="lg" href={RELEASES_LATEST_PAGE}>
                {RELEASES_PAGE.github}
              </Button>
            </div>
          )}
        </div>
      </section>
    </MarketingPage>
  );
}
