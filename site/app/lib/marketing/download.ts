/*
 * Download CTA — single source of truth. Every "Download for Mac" button links to the
 * `/download` page, which auto-starts the file via the `/download.dmg` resource route
 * (`routes/download[.]dmg.tsx` — resolves the newest build's .dmg) while showing the
 * install steps. Keeping the paths + repo coordinates in one place means a version bump
 * or a repo move touches one line, never the sections.
 */

/** Same-origin href every download CTA points at — the download page (auto-starts the file). */
export const DOWNLOAD_PATH = "/download";

/** The direct file fetch — a 302 to the latest release's .dmg. */
export const DOWNLOAD_DMG_PATH = "/download.dmg";

/** The GitHub repo the packaged app publishes to (mirrors `ui/electron-builder.yml` → `publish`). */
export const RELEASE_REPO = { owner: "benhonda", repo: "coldstorage" } as const;

/** Human releases page — the fallback when the release API can't be resolved. */
export const RELEASES_LATEST_PAGE = `https://github.com/${RELEASE_REPO.owner}/${RELEASE_REPO.repo}/releases/latest`;
