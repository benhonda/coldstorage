import type { Route } from "./+types/download[.]dmg";
import { serverRedirect } from "~/lib/router/server-responses.server";
import { RELEASE_REPO, RELEASES_LATEST_PAGE } from "~/lib/marketing/download";
import { logError } from "~/lib/logger";

/** Shape of the bits of the GitHub "latest release" payload we read. */
type GithubAsset = { name: string; browser_download_url: string };
type GithubRelease = { assets: GithubAsset[] };

/**
 * `/download.dmg` — resource route (loader-only, no component) that the `/download` page
 * auto-starts (and its "Download again" button re-triggers). It asks GitHub for the *latest*
 * release and 302s the browser straight to that release's macOS `.dmg`, so the marketing
 * side never hardcodes a version that would rot on the next build (the asset filename
 * carries the version).
 *
 * The redirect is CDN-cached for an hour, so the GitHub API is hit at most ~once/hour per
 * region — well under the unauthenticated rate limit — while visitors still get an instant
 * 302. Any failure (API down, no `.dmg`) falls back to the human releases page so the button
 * never dead-ends.
 */
export async function loader(_args: Route.LoaderArgs) {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${RELEASE_REPO.owner}/${RELEASE_REPO.repo}/releases/latest`,
      { headers: { Accept: "application/vnd.github+json" } }
    );
    if (!res.ok) throw new Error(`GitHub releases API responded ${res.status}`);

    const release = (await res.json()) as GithubRelease;
    const dmg = release.assets.find((a) => a.name.toLowerCase().endsWith(".dmg"));
    if (!dmg) throw new Error("latest release has no .dmg asset");

    return serverRedirect(
      { externalUrl: dmg.browser_download_url },
      // Cache the resolved redirect at the edge; revalidate hourly, serve stale meanwhile.
      { headers: { "Cache-Control": "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400" } }
    );
  } catch (err) {
    logError("download: could not resolve the latest .dmg, sending to the releases page", err);
    // Short cache on the fallback so we recover quickly once the API is healthy again.
    return serverRedirect(
      { externalUrl: RELEASES_LATEST_PAGE },
      { headers: { "Cache-Control": "public, max-age=0, s-maxage=60" } }
    );
  }
}
