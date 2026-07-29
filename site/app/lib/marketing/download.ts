/*
 * Download CTA — single source of truth. Every CTA lands on the `/download` page, and the page
 * NEVER auto-starts the file: the visitor's click on the page's own button is the only thing
 * that fetches it (Ben's call, 2026-07-28 — and it's also how Screen Studio does it). The page
 * pairs that button with a static requirements line and a warn-only Intel notice
 * (`components/marketing/arch-notice.tsx`), since the release is arm64-only.
 *
 * The file itself always comes from `/download.dmg` (`routes/download[.]dmg.tsx` — resolves
 * the newest build's .dmg), so a version bump or repo move touches one line here, never the
 * sections.
 */

/** The download page — every CTA points here, whatever its label. */
export const DOWNLOAD_PATH = "/download";

/** The on-site version archive (`($lang).releases.tsx`) — where "All releases" points.
 *  Fed by the same GitHub Releases API the `.dmg` resolver reads, so it lists exactly
 *  what's downloadable without ever sending a visitor to raw GitHub. */
export const RELEASES_PATH = "/releases";

/** The direct file fetch — a 302 to the latest release's .dmg. */
export const DOWNLOAD_DMG_PATH = "/download.dmg";

/** The GitHub repo the packaged app publishes to (mirrors `ui/electron-builder.yml` → `publish`). */
export const RELEASE_REPO = { owner: "benhonda", repo: "coldstorage" } as const;

/** GitHub's own releases page — the last-resort fallback when the release API can't be
 *  resolved (used by the `.dmg` resolver's error path and the `/releases` page's empty
 *  state), NOT a visitor-facing destination — those go to `RELEASES_PATH`. */
export const RELEASES_LATEST_PAGE = `https://github.com/${RELEASE_REPO.owner}/${RELEASE_REPO.repo}/releases/latest`;
