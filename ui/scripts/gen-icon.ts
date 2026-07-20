/**
 * Generates ui/build/icon.png — the macOS app icon. Run via `task ui:icon:build`.
 *
 * electron-builder takes a 1024×1024 PNG and rasterises every Apple size slot itself
 * (bundled resvg — no iconutil, no Xcode), so this one file is the whole icon. See
 * electron-builder.yml `mac.icon`.
 *
 * The mark is NOT redrawn here. The designer-delivered SVG in site/design-mirror/brand/ is read
 * verbatim and nested unmodified into the tile — stroke colour, stroke weight and the mark's own
 * lift shadow all stay as delivered. The ONLY thing authored here is the tile beneath it.
 *
 * Reading the SVG rather than copying its path data is what keeps this DRY (PILLAR3): re-run the
 * task when the mark changes and the icon follows. Nothing enforces that re-run, though — the
 * committed PNG can go stale if a brand update skips it.
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
 * The dark-variant-on-dark-tile pairing is a design decision, not a toggle — a macOS app has exactly
 * one icon, so there is no light/dark counterpart to switch to. See the "app icon" section of
 * site/design-mirror/brand/README.md for why the dark mark's receding stroke wants this ground.
 */
const MARK_VARIANT = 'logo-for-darkmode.svg'
const TILE_GRADIENT = ['#12395A', '#071B2B']

/**
 * Superellipse |x/a|^n + |y/a|^n = 1, sampled as a polyline. n=5 approximates Apple's
 * continuous corner curvature closely enough to be indistinguishable at icon sizes.
 */
const SQUIRCLE_N = 5
const SQUIRCLE_STEPS = 720
function squirclePath(size: number): string {
  const n = SQUIRCLE_N
  const steps = SQUIRCLE_STEPS
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
 * Pull the artboard size out of a delivered SVG's viewBox. Tolerates decimals and comma or
 * whitespace separators — designer tools emit all of these. Every element is checked explicitly
 * rather than cast, so a malformed viewBox throws here instead of producing NaN geometry that
 * silently renders a misplaced mark.
 */
function parseViewBox(file: string, src: string): { w: number; h: number } {
  const vb = src.match(/viewBox="([\d.,\s-]+)"/)
  if (!vb?.[1]) throw new Error(`${file}: no viewBox — can't place the mark without knowing its artboard.`)

  const [minX, minY, w, h] = vb[1].trim().split(/[\s,]+/).map(Number)
  if (minX === undefined || minY === undefined || w === undefined || h === undefined) {
    throw new Error(`${file}: viewBox "${vb[1]}" doesn't have four values.`)
  }
  if ([minX, minY, w, h].some(Number.isNaN)) throw new Error(`${file}: viewBox "${vb[1]}" has non-numeric values.`)
  if (minX !== 0 || minY !== 0) {
    throw new Error(`${file}: viewBox origin is (${minX},${minY}), not (0,0) — the placement maths assumes a zero origin.`)
  }
  if (w <= 0 || h <= 0) throw new Error(`${file}: viewBox has a non-positive extent (${w}×${h}).`)

  return { w, h }
}

/**
 * Read a delivered variant and re-emit it as a *nested* <svg> placed on the canvas.
 * Nesting (rather than splicing paths out) is what keeps it verbatim: the file's own
 * viewBox does the scaling and its filter defs stay self-contained. Only the outer
 * element's sizing attributes are rewritten.
 */
function nestMark(file: string): string {
  const src = readFileSync(`${BRAND}/${file}`, 'utf8')

  const { w, h } = parseViewBox(file, src)

  const k = (BODY * MARK_SCALE) / h
  const x = GUTTER + (BODY - w * k) / 2
  const y = GUTTER + (BODY - h * k) / 2

  // MUST be a capture-then-assert, not a bare .replace: a regex that doesn't match makes String.replace a
  // silent no-op returning the original string. The nested <svg> would keep its delivered width/height and
  // no x/y, so the mark would render at ~101px in the top-left corner of a 1024 canvas — and the script
  // would still exit 0 saying "wrote icon.png". A leading XML prolog, BOM, comment or newline is enough to
  // trigger it, and all are normal designer-tool output. Fail loudly instead.
  const openTag = src.match(/<svg[^>]*>/)
  if (!openTag?.[0] || openTag.index === undefined) throw new Error(`${file}: no <svg> element found.`)
  const openTagStart = openTag.index

  const replacement = `<svg x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${(w * k).toFixed(2)}" height="${(h * k).toFixed(2)}" viewBox="0 0 ${w} ${h}" fill="none" xmlns="http://www.w3.org/2000/svg">`
  // Slice rather than .replace() — the replacement string contains no `$`, but splicing by index is
  // immune to `$&`-style substitution regardless of what a future gradient id contains.
  return (src.slice(0, openTagStart) + replacement + src.slice(openTagStart + openTag[0].length)).trim()
}

const [from, to] = TILE_GRADIENT
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}">
  <defs>
    <linearGradient id="tile" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/>
    </linearGradient>
  </defs>
  <g transform="translate(${GUTTER},${GUTTER})">
    <path d="${squirclePath(BODY)}" fill="url(#tile)"/>
  </g>
  ${nestMark(MARK_VARIANT)}
</svg>`

await sharp(Buffer.from(svg)).png().toFile(OUT)
console.log(`wrote ${OUT}  (${CANVAS}×${CANVAS}, ${MARK_VARIANT} on a ${from}→${to} tile)`)
