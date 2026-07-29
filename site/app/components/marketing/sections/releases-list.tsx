/*
 * Section · ReleasesList — the rows of `/releases`: one per published build, newest first.
 *
 * Purely presentational: the route's loader talks to the GitHub Releases API and hands rows
 * down pre-formatted (dates and sizes are server-rendered strings, so the page needs no
 * client JS and can't hydrate-mismatch on locale). Release notes render as plain text —
 * electron-builder bodies are short or empty, and a markdown pipeline for them would be
 * weight the page doesn't need.
 */
import "./releases-list.css";
import { Badge } from "~/components/ds/badge";
import { Button } from "~/components/ds/button";
import { RELEASES_PAGE } from "~/lib/marketing/content";

/** One published build, pre-formatted by the loader. */
export type ReleaseRow = {
  /** Tag as published, e.g. "v0.1.4". */
  version: string;
  /** Human date, already formatted server-side, e.g. "July 27, 2026". */
  date: string;
  /** Human size of the .dmg, e.g. "142 MB". */
  size: string;
  /** Direct asset URL — GitHub's CDN serves the file; no page transition. */
  dmgUrl: string;
  /** Release notes body, trimmed; null when the release has none. */
  notes: string | null;
};

export function ReleasesList({ releases }: { releases: ReleaseRow[] }) {
  return (
    <ol className="cs-releases">
      {releases.map((release, i) => (
        <li key={release.version} className="cs-releases__row">
          <div className="cs-releases__head">
            <span className="cs-releases__version">{release.version}</span>
            {i === 0 ? <Badge tone="accent">{RELEASES_PAGE.latest}</Badge> : null}
            <span className="cs-releases__meta">
              {release.date} · {release.size}
            </span>
            <div className="cs-releases__action">
              <Button variant={i === 0 ? "primary" : "ghost"} size="sm" icon="download" href={release.dmgUrl}>
                {RELEASES_PAGE.download}
              </Button>
            </div>
          </div>
          {release.notes ? <p className="cs-releases__notes">{release.notes}</p> : null}
        </li>
      ))}
    </ol>
  );
}
