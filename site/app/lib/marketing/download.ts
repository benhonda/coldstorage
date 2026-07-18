/*
 * Download CTA — single source of truth. Both CTA styles land on the `/download` page; what
 * differs is whether arriving there starts the file, and that is driven by **what the button
 * says**:
 *
 *  - A button labelled "Download…" → `DOWNLOAD_START_PATH`. The label promises a download, so
 *    the page auto-starts it and says so. Pressing "Download" and getting a landing page that
 *    then asks you to press "Download" again is the thing we're avoiding.
 *  - A button that does NOT say download (the pricing table's "Get started" / "Choose") →
 *    `DOWNLOAD_PATH`. Those read like navigation, so they navigate; the visitor starts the
 *    file themselves from the page.
 *
 * Either way the page carries a manual button, which is both the fallback for a blocked
 * auto-start and the only control on the non-auto path. The file itself always comes from
 * `/download.dmg` (`routes/download[.]dmg.tsx` — resolves the newest build's .dmg), so a
 * version bump or repo move touches one line here, never the sections.
 */

/** The download page, no auto-start — for CTAs that don't say "download". */
export const DOWNLOAD_PATH = "/download";

/** The download page WITH auto-start — for any CTA labelled "Download…".
 *  `?start=1` is read server-side, so the auto-start works without JS. */
export const DOWNLOAD_START_PATH = "/download?start=1";

/** The direct file fetch — a 302 to the latest release's .dmg. */
export const DOWNLOAD_DMG_PATH = "/download.dmg";

/** The GitHub repo the packaged app publishes to (mirrors `ui/electron-builder.yml` → `publish`). */
export const RELEASE_REPO = { owner: "benhonda", repo: "coldstorage" } as const;

/** Human releases page — the fallback when the release API can't be resolved. */
export const RELEASES_LATEST_PAGE = `https://github.com/${RELEASE_REPO.owner}/${RELEASE_REPO.repo}/releases/latest`;
