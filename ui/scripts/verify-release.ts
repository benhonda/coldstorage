/**
 * Checks that a GitHub release carries everything the auto-updater needs, BEFORE it goes live.
 * Run via `task ui:mac:release:verify`; `ui:mac:release` runs it between uploading and publishing.
 *
 * Reads `gh release view --json isDraft,assets` output on stdin. Exits non-zero if anything the
 * updater depends on is missing, so a half-finished upload can never be published.
 *
 * This lives in a file rather than a `node -e '…'` block in the Taskfile on purpose: the inline
 * version silently broke the moment its message text contained an apostrophe (it closed the shell's
 * single-quoted string mid-script), and nothing typechecked it. Same reasoning as gen-icon.ts.
 */

import { readFileSync } from 'node:fs'

/** The shape of `gh release view --json isDraft,assets`. */
type ReleaseView = {
  isDraft: boolean
  assets: { name: string }[]
}

/**
 * electron-updater reads `latest-mac.yml` to discover a new version and applies the update from the
 * `.zip` — the `.dmg` is only ever the first-time human download. Missing either of the first two
 * publishes a feed that every installed app will choke on.
 */
const REQUIRED = [
  { label: 'latest-mac.yml (the update feed)', hit: (n: string) => n === 'latest-mac.yml' },
  { label: 'a .zip (what electron-updater applies)', hit: (n: string) => n.endsWith('.zip') },
  { label: 'a .dmg (the download-page artifact)', hit: (n: string) => n.endsWith('.dmg') },
]

function parse(raw: string): ReleaseView {
  const data: unknown = JSON.parse(raw)
  if (typeof data !== 'object' || data === null) throw new Error('expected a JSON object from `gh release view`')

  const { isDraft, assets } = data as Record<string, unknown>
  if (typeof isDraft !== 'boolean') throw new Error('`isDraft` missing or not a boolean')
  if (!Array.isArray(assets)) throw new Error('`assets` missing or not an array')

  return {
    isDraft,
    assets: assets.map((a, i) => {
      const name = (a as Record<string, unknown> | null)?.name
      if (typeof name !== 'string') throw new Error(`asset[${i}] has no name`)
      return { name }
    }),
  }
}

// fd 0 rather than Bun.stdin — keeps this runnable under plain node and avoids depending on
// @types/bun just to read a pipe.
const release = parse(readFileSync(0, 'utf8'))
const names = release.assets.map((a) => a.name)

console.log(`${names.length} asset(s) on ${release.isDraft ? 'DRAFT' : 'PUBLISHED'} release:`)
for (const n of names) console.log(`   · ${n}`)

const missing = REQUIRED.filter((r) => !names.some(r.hit))
if (missing.length) {
  console.error('\n✋ NOT safe to publish — missing:')
  for (const m of missing) console.error(`   ✗ ${m.label}`)
  console.error('\n   Re-run the release — it re-uploads into the same draft.')
  process.exit(1)
}

if (!release.isDraft) {
  console.log('\n✓ assets complete — but this release is ALREADY PUBLISHED, so the feed is live.')
  process.exit(0)
}

console.log('\n✓ Safe to publish. Publishing creates the tag and takes the feed live for every installed app.')
