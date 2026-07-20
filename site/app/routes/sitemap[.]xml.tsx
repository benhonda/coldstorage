import { INDEXABLE_ROUTES, absoluteUrl } from "~/lib/marketing/site-routes";

/**
 * `/sitemap.xml` — resource route (loader-only, no component) generated from
 * `INDEXABLE_ROUTES`, the one list that says which pages exist to be found.
 *
 * Generated rather than checked in as a static file for the usual reason: a static
 * `public/sitemap.xml` is a second copy of the route table that nothing forces anyone to
 * update, so it goes stale the first time a page is added and no one notices, because a stale
 * sitemap fails silently — the page simply never gets crawled (PILLAR3).
 *
 * `lastmod` is deliberately omitted. The honest value is "when did this page's content last
 * change", which we don't track per-route; emitting the build time instead would tell crawlers
 * every page changed on every deploy, which is worse than saying nothing — it trains them to
 * ignore the field. Add it per-route only if we ever track real content dates.
 */
export function loader() {
  const urls = INDEXABLE_ROUTES.map(
    ({ path, priority, changefreq }) =>
      `  <url>\n` +
      `    <loc>${absoluteUrl(path)}</loc>\n` +
      `    <changefreq>${changefreq}</changefreq>\n` +
      `    <priority>${priority.toFixed(1)}</priority>\n` +
      `  </url>`
  ).join("\n");

  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    `${urls}\n` +
    `</urlset>\n`;

  return new Response(xml, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      // Crawlers re-fetch this often; an hour at the edge keeps it fresh without hitting origin.
      "Cache-Control": "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
}
