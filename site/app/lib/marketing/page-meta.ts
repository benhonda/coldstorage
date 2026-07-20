/*
 * The shared `meta()` builder — one place that decides what every marketing page puts in its
 * head: title, description, Open Graph, and the canonical URL.
 *
 * Why a helper and not per-route literals: the head is four near-identical blocks on fourteen
 * routes. Hand-writing them guarantees the fifth page added forgets the canonical and nobody
 * notices, because a missing canonical looks exactly like a working page (PILLAR3).
 *
 * ── The `/fr` problem this exists to fix ─────────────────────────────────────────────────
 * Routes are `($lang).*`, so every page answers on two URLs: `/pricing` and `/fr/pricing`.
 * The i18n pass hasn't happened, so today BOTH return the same English HTML — verified, not
 * assumed. That is textbook duplicate content: two indexable URLs, identical bodies, no signal
 * about which is canonical. Search engines pick one on their own and split ranking signals
 * across the pair.
 *
 * So while `TRANSLATIONS_LIVE` is false, the French URL canonicals to the English one — which
 * is precisely what canonical is for: "this is the same page as that one." It is NOT `noindex`,
 * because that throws away the URL rather than consolidating it, and it would have to be undone.
 *
 * WHEN `/fr` GETS REAL FRENCH COPY: flip `TRANSLATIONS_LIVE` to true. Each page then canonicals
 * to itself (a translation is its own page, not a duplicate) and gets `hreflang` pairs so the
 * two are declared as alternates. Both behaviours are below — the flag is the whole change.
 */
import { absoluteUrl } from "~/lib/marketing/site-routes";

/**
 * Whether `/fr` serves genuinely French copy yet.
 *
 * FALSE today: the routes exist and render, but the strings are still English (only
 * `_index.tsx` has a translated description). Flip this the moment real translations ship —
 * leaving it false once they do would tell search engines to ignore the French pages entirely.
 */
export const TRANSLATIONS_LIVE = false;

export type PageMetaInput = {
  /** Site-relative path, no language prefix — e.g. `/pricing`. `/` for home. */
  path: string;
  title: string;
  description: string;
  /** From `params.lang`; only `"fr"` is meaningful. */
  lang?: string;
  /** Overrides for the social card when the page title isn't the right share text. */
  og?: { title?: string; description?: string };
  /** JSON-LD nodes to emit alongside. Already-built objects, not raw strings. */
  jsonLd?: Record<string, unknown>[];
};

/** A `meta()` descriptor. Loose by necessity — RR7 accepts several different shapes. */
type MetaDescriptor = Record<string, unknown>;

/**
 * Build the full head for a marketing page.
 *
 * @example
 *   export function meta({ params }: Route.MetaArgs) {
 *     return pageMeta({
 *       path: "/pricing",
 *       title: "ColdStorage — Pricing",
 *       description: "…",
 *       lang: params.lang,
 *     });
 *   }
 */
export function pageMeta({
  path,
  title,
  description,
  lang,
  og,
  jsonLd = [],
}: PageMetaInput): MetaDescriptor[] {
  const isFrench = lang === "fr";
  const englishUrl = absoluteUrl(path);
  const frenchUrl = absoluteUrl(path === "/" ? "/fr" : `/fr${path}`);
  const selfUrl = isFrench ? frenchUrl : englishUrl;

  // Untranslated: the French URL is a duplicate, so it points at the English original.
  // Translated: each points at itself, and the two are declared as alternates.
  const canonical = TRANSLATIONS_LIVE ? selfUrl : englishUrl;

  const alternates: MetaDescriptor[] = TRANSLATIONS_LIVE
    ? [
        { tagName: "link", rel: "alternate", hrefLang: "en", href: englishUrl },
        { tagName: "link", rel: "alternate", hrefLang: "fr", href: frenchUrl },
        { tagName: "link", rel: "alternate", hrefLang: "x-default", href: englishUrl },
      ]
    : [];

  return [
    { title },
    { name: "description", content: description },

    { property: "og:type", content: "website" },
    { property: "og:site_name", content: "ColdStorage" },
    { property: "og:title", content: og?.title ?? title },
    { property: "og:description", content: og?.description ?? description },
    { property: "og:url", content: selfUrl },
    { property: "og:locale", content: isFrench ? "fr_CA" : "en_US" },

    { tagName: "link", rel: "canonical", href: canonical },
    ...alternates,

    ...jsonLd.map((node) => ({ "script:ld+json": node })),
  ];
}
