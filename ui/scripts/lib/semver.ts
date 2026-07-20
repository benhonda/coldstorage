/**
 * The tiny bit of semver the release tasks need. Deliberately not a dependency: we only ever handle
 * plain `x.y.z` (no prereleases, no build metadata — a released ColdStorage build is always one of
 * those three numbers), and the release path shouldn't grow a package for twenty lines of arithmetic.
 *
 * Lives in a module rather than repeated `node -e '…'` blocks in Taskfile.yml: that pattern silently
 * broke once already when a message string contained an apostrophe and closed the shell's quoting
 * mid-script, and nothing typechecked it.
 */

export type Version = readonly [major: number, minor: number, patch: number]

/** Strict `x.y.z` only — anything else throws rather than degrading into NaN comparisons. */
export function parse(raw: string): Version {
  if (!/^\d+\.\d+\.\d+$/.test(raw)) throw new Error(`'${raw}' isn't a plain x.y.z version.`)

  const [major, minor, patch] = raw.split('.').map(Number)
  if (major === undefined || minor === undefined || patch === undefined) throw new Error(`'${raw}' isn't a plain x.y.z version.`)

  return [major, minor, patch]
}

export function format(v: Version): string {
  return v.join('.')
}

/** Negative when a < b, zero when equal, positive when a > b. Numeric, so 0.1.10 > 0.1.9. */
export function compare(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) {
    const [x, y] = [a[i], b[i]]
    if (x !== undefined && y !== undefined && x !== y) return x - y
  }
  return 0
}

export type Level = 'patch' | 'minor' | 'major'

export function isLevel(value: string): value is Level {
  return value === 'patch' || value === 'minor' || value === 'major'
}

export function bump([major, minor, patch]: Version, level: Level): Version {
  switch (level) {
    case 'major':
      return [major + 1, 0, 0]
    case 'minor':
      return [major, minor + 1, 0]
    case 'patch':
      return [major, minor, patch + 1]
  }
}
