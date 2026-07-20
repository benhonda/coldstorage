/**
 * Exits 0 only if <candidate> is strictly ahead of <baseline>. Used by `task ui:mac:release:upload`
 * as its bump guard, so re-running an upload without bumping can never overwrite a published
 * release's assets — including its `latest-mac.yml`, which every installed app reads.
 *
 *   assert-version-ahead.ts <candidate> <baseline>
 *
 * An empty <baseline> means nothing is published yet (first release) and passes.
 */
import { compare, format, parse } from './lib/semver.ts'

const [, , rawCandidate, rawBaseline] = process.argv

if (!rawCandidate) {
  console.error('usage: assert-version-ahead.ts <candidate> <baseline>')
  process.exit(2)
}

if (!rawBaseline?.trim()) {
  console.error(`no published release yet — first release of ${rawCandidate}, bump guard n/a.`)
  process.exit(0)
}

try {
  const candidate = parse(rawCandidate)
  const baseline = parse(rawBaseline.trim())

  if (compare(candidate, baseline) <= 0) {
    console.error(`✋ Refusing to release: ui/package.json version (${format(candidate)}) is NOT ahead of the latest published release (${format(baseline)}).`)
    console.error("   Run 'task ui:mac:release' — it picks the version for you.")
    process.exit(1)
  }

  console.error(`version ${format(candidate)} is ahead of the latest release (${format(baseline)}) — ok to release.`)
} catch (error) {
  // A non-x.y.z version on either side is a judgement call, not something to guess at.
  console.error(`✋ ${error instanceof Error ? error.message : String(error)} — compare by hand.`)
  process.exit(2)
}
