/**
 * The ColdStorage mark's own colours — the five values that make the ice cube.
 *
 * SSOT (PILLAR3). These are NOT DS tokens: the DS palette is the *interface* vocabulary
 * (surfaces, text, accent), while these are the brand artifact's internals. They do not
 * change with theme or product surface, and nothing but the mark should consume them.
 *
 * Two consumers, and that is exactly why this file exists: `BrandMark` paints the geometry
 * with them, and the `/brand` page publishes them as documentation. Before this, a swatch on
 * a brand page would have been a hand-copied hex — a second source of truth that goes stale
 * silently, and does so on the one page whose entire job is being correct about the brand.
 *
 * The two outline values are the single exception to that: the light/dark cut flips on the
 * `.dark` class, which is a CSS concern, so they are also declared as `--brandmark-stroke` in
 * `app/components/ds/brand-mark.css`. That file points back here. If you change one, change both.
 */

/** Every documented colour in the mark, in the order the `/brand` page lists them. */
export const BRAND_MARK_PALETTE = {
  cubeTop: "#FFFFFF",
  cubeLeft: "#C1E4FB",
  cubeRight: "#99CFF0",
  outlineLight: "#4DA2DA",
  outlineDark: "#2F668E",
} as const;

/**
 * Keys of the mark palette. Exported so the `/brand` page's swatch captions can be typed as a
 * total `Record<BrandColorKey, string>` — add a colour above and the copy fails to typecheck
 * until it is described, rather than silently rendering an unlabelled chip (PILLAR4).
 */
export type BrandColorKey = keyof typeof BRAND_MARK_PALETTE;

/** Display order for the swatch list — `Object.keys` order is not a contract worth relying on. */
export const BRAND_COLOR_ORDER = [
  "cubeTop",
  "cubeLeft",
  "cubeRight",
  "outlineLight",
  "outlineDark",
] as const satisfies readonly BrandColorKey[];
