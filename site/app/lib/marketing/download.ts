/*
 * Download CTA — single source of truth. Every "Download for Mac" button links here, and
 * the `/download` resource route (see `routes/download.tsx`) resolves it to the newest
 * build's .dmg. Keeping the path + repo coordinates in one place means a version bump or a
 * repo move touches one line, never the sections.
 */

/** Same-origin href every download CTA points at — a 302 to the latest .dmg. */
export const DOWNLOAD_PATH = "/download";

/** The GitHub repo the packaged app publishes to (mirrors `ui/electron-builder.yml` → `publish`). */
export const RELEASE_REPO = { owner: "benhonda", repo: "coldstorage" } as const;

/** Human releases page — the fallback when the release API can't be resolved. */
export const RELEASES_LATEST_PAGE = `https://github.com/${RELEASE_REPO.owner}/${RELEASE_REPO.repo}/releases/latest`;
