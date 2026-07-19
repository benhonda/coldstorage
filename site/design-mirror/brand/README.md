# Brand originals

Designer-delivered brand source, kept verbatim. **Unlike the rest of `design-mirror/`, these
are hand-delivered — `DesignSync` does not own or refresh them.** They are here as the
reference to diff against when the mark changes, not as build inputs.

## The mark

`logo-for-lightmode.svg` / `logo-for-darkmode.svg` — the ice-cube mark, one variant per
background. Diffed, the two are the **same geometry** (both hexagons are half-width 43; the
dark file is simply translated +1.3076 on both axes to make room for its larger blur). Only
four values actually differ:

| | light-bg | dark-bg |
|---|---|---|
| hexagon stroke | `#4DA2DA` | `#2F668E` |
| stroke width | `5.76271` | `6.3779` |
| shadow `stdDeviation` | `1.5` | `2` |
| shadow opacity | `0.25` | `0.6` |

So the site does **not** ship two SVGs. `app/components/ds/brand-mark.tsx` holds the geometry
once and flips those four values from CSS custom properties under `.dark`
(`brand-mark.css`) — one source of truth, one inlined mark, no second fetch.

One deliberate approximation: the shadow blur is fixed at `2` for both, because `stdDeviation`
is not a CSS-settable property and the 1.5-vs-2 delta is sub-pixel at every size the mark
renders. The visible difference between the variants is opacity, and that is exact.

## The favicon package

`coldstorage-fav-light-mode.zip` — a RealFaviconGenerator package, extracted into
`site/public/` and linked from `app/root.tsx`.

Two things the filename gets wrong, worth knowing before regenerating:

- It is **not** light-mode-only. `favicon.svg` embeds *both* variants with an internal
  `prefers-color-scheme` style block, so it swaps with the browser chrome on its own. That is
  why `root.tsx` links one icon rather than a light/dark pair.
- The generator tagged the 192/512 PNGs `"purpose": "maskable"`, but the mark fills the
  artboard edge-to-edge with no safe zone — an Android circular mask would clip the hexagon's
  corners. `site/public/site.webmanifest` corrects these to `"any"`. Re-apply that fix if the
  package is ever regenerated.
