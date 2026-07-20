/**
 * Generates ui/build/icon.png — the macOS app icon. Run via `task ui:icon:build`.
 *
 * electron-builder takes a 1024×1024 PNG and rasterises every Apple size slot itself
 * (bundled resvg — no iconutil, no Xcode), so this one file is the whole icon. See
 * electron-builder.yml `mac.icon`.
 *
 * The mark is NOT redrawn here. Both designer-delivered variants in
 * site/design-mirror/brand/ are read verbatim and nested unmodified into the tile —
 * stroke colour, stroke weight and the mark's own lift shadow all stay as delivered.
 * The ONLY things authored here are the tile beneath and which variant sits on it:
 *
 *   dark tile  → logo-for-darkmode.svg   (stroke recedes; the ice faces carry the mark)
 *   light tile → logo-for-lightmode.svg  (brighter stroke holds the silhouette)
 *
 * That pairing is the designer's, not ours — it mirrors how app/components/ds/brand-mark.css
 * flips the same four values under `.dark`. Reading the SVGs rather than copying their paths
 * is what keeps this DRY (PILLAR3): re-run the task when the mark changes and the icon follows.
 *
 * Tile geometry is Apple's macOS app-icon template: 1024 canvas, 824 body, 100px gutters,
 * continuous-curvature squircle (an n=5 superellipse — a plain border-radius rounded rect is
 * visibly wrong at this size). No shadow under the TILE: macOS 26 strips baked tile shadows,
 * and baking one risks doubling up if we later move to Icon Composer's `.icon` format.
 *
 * Note for macOS 26 (Tahoe): the system wraps any classic icon in its own grey squircle until
 * the app ships an Icon Composer `.icon`. electron-builder supports that (26.2.0+) but it
 * requires Xcode 26 on the build machine plus a separate `.icns` for the DMG volume — a
 * deliberate later pass, tracked in PROD.md Phase 6a.
 */
import sharp from 'sharp'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BRAND = resolve(HERE, '../../site/design-mirror/brand')
const OUT = resolve(HERE, '../build/icon.png')

const CANVAS = 1024
const BODY = 824
const GUTTER = (CANVAS - BODY) / 2
/** Mark height as a fraction of the tile body. */
const MARK_SCALE = 0.62

/**
 * Which variant sits on which tile. Only `dark` is emitted today; `light` is kept
 * wired so switching is a one-line change rather than a rewrite.
 */
const TILES = {
  dark: {
    variant: 'logo-for-darkmode.svg',
    gradient: ['#12395A', '#071B2B'],
  },
  light: {
    variant: 'logo-for-lightmode.svg',
    gradient: ['#FFFFFF', '#E8F2F9'],
  },
}
const TILE = TILES.dark

/**
 * Superellipse |x/a|^n + |y/a|^n = 1, sampled as a polyline. n=5 approximates Apple's
 * continuous corner curvature closely enough to be indistinguishable at icon sizes.
 */
function squirclePath(size, n = 5, steps = 720) {
  const a = size / 2
  const pts = []
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * 2 * Math.PI
    const c = Math.cos(t)
    const s = Math.sin(t)
    const x = Math.sign(c) * a * Math.abs(c) ** (2 / n)
    const y = Math.sign(s) * a * Math.abs(s) ** (2 / n)
    pts.push(`${(a + x).toFixed(2)},${(a + y).toFixed(2)}`)
  }
  return `M${pts.join('L')}Z`
}

/**
 * Read a delivered variant and re-emit it as a *nested* <svg> placed on the canvas.
 * Nesting (rather than splicing paths out) is what keeps it verbatim: the file's own
 * viewBox does the scaling and its filter defs stay self-contained. Only the outer
 * element's sizing attributes are rewritten.
 */
function nestMark(file) {
  const src = readFileSync(`${BRAND}/${file}`, 'utf8')
  const match = src.match(/viewBox="0 0 (\d+) (\d+)"/)
  if (!match) throw new Error(`${file}: no "0 0 W H" viewBox — the delivered artboard changed shape; check the file before trusting the icon.`)
  const [, w, h] = match.map(Number)

  const k = (BODY * MARK_SCALE) / h
  const x = GUTTER + (BODY - w * k) / 2
  const y = GUTTER + (BODY - h * k) / 2

  return src
    .replace(
      /^<svg[^>]*>/,
      `<svg x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${(w * k).toFixed(2)}" height="${(h * k).toFixed(2)}" viewBox="0 0 ${w} ${h}" fill="none" xmlns="http://www.w3.org/2000/svg">`
    )
    .trim()
}

const [from, to] = TILE.gradient
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}">
  <defs>
    <linearGradient id="tile" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/>
    </linearGradient>
  </defs>
  <g transform="translate(${GUTTER},${GUTTER})">
    <path d="${squirclePath(BODY)}" fill="url(#tile)"/>
  </g>
  ${nestMark(TILE.variant)}
</svg>`

await sharp(Buffer.from(svg)).png().toFile(OUT)
console.log(`wrote ${OUT}  (${CANVAS}×${CANVAS}, ${TILE.variant} on a ${from}→${to} tile)`)
