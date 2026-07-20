/**
 * Decides the version for a release and writes it into ui/package.json.
 *
 * Used by `task ui:mac:release`. With no --level/--version it shows where things stand and prompts;
 * otherwise it resolves non-interactively. The chosen version goes to STDOUT (so the caller can
 * capture it); everything human-facing goes to STDERR, so `$(…)` around this never picks up UI text.
 *
 * The forward-only check has to happen HERE, before the caller commits and pushes the bump — the
 * upload step's own guard runs after that, so a typo like 0.0.1 would otherwise leave a junk release
 * commit on main before anything refused it.
 *
 *   set-release-version.ts --current 0.1.2 [--live 0.1.2] [--level patch|minor|major] [--version x.y.z]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bump, compare, format, isLevel, parse, type Version } from './lib/semver.ts'

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '../package.json')

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

function fail(message: string): never {
  console.error(`✋ ${message}`)
  process.exit(1)
}

const rawCurrent = arg('current')
if (!rawCurrent) fail('--current <x.y.z> is required.')

let current: Version
try {
  current = parse(rawCurrent)
} catch {
  fail(`ui/package.json version '${rawCurrent}' isn't a plain x.y.z — fix it before releasing.`)
}

// Absent when nothing has ever been published, which is a legitimate first-release state.
const rawLive = arg('live')?.trim()
let live: Version | undefined
if (rawLive) {
  try {
    live = parse(rawLive)
  } catch {
    fail(`the live release tag '${rawLive}' isn't a plain x.y.z — check GitHub before releasing.`)
  }
}

const candidates = { patch: bump(current, 'patch'), minor: bump(current, 'minor'), major: bump(current, 'major') }

async function choose(): Promise<Version> {
  const requested = arg('version')
  if (requested) {
    try {
      return parse(requested)
    } catch {
      fail(`--version '${requested}' isn't a plain x.y.z.`)
    }
  }

  const level = arg('level')
  if (level) {
    if (!isLevel(level)) fail(`--level must be patch|minor|major (got '${level}').`)
    return candidates[level]
  }

  // Interactive: the menu is UI, so it goes to stderr — stdout carries only the answer.
  console.error('')
  console.error(`  live on GitHub:  ${live ? `v${format(live)}` : 'none yet'}`)
  console.error(`  in package.json: v${format(current)}`)
  console.error('')
  console.error(`  1) patch → ${format(candidates.patch)}`)
  console.error(`  2) minor → ${format(candidates.minor)}`)
  console.error(`  3) major → ${format(candidates.major)}`)
  console.error('  …or type a version outright (e.g. 0.4.0)')
  console.error('  q) cancel')
  console.error('')

  const rl = createInterface({ input: process.stdin, output: process.stderr })
  const answer = (await rl.question('release which? [1] ')).trim()
  rl.close()

  switch (answer) {
    case '':
    case '1':
    case 'patch':
      return candidates.patch
    case '2':
    case 'minor':
      return candidates.minor
    case '3':
    case 'major':
      return candidates.major
    case 'q':
    case 'Q':
      console.error('Cancelled.')
      process.exit(1)
    default:
      try {
        return parse(answer)
      } catch {
        fail(`'${answer}' isn't a valid x.y.z version.`)
      }
  }
}

const next = await choose()

if (compare(next, current) <= 0) fail(`${format(next)} is not ahead of the current ${format(current)}.`)
if (live && compare(next, live) <= 0) fail(`${format(next)} is not ahead of the live release ${format(live)}.`)

// Rewrite just the version value, preserving the file's formatting. `bun pm version` would also create
// a git tag, and the tag must come from GitHub publishing the draft (it attaches to origin/main's head),
// never from a local tag that could disagree with the built binary.
const src = readFileSync(PKG, 'utf8')
const updated = src.replace(`"version": "${format(current)}"`, `"version": "${format(next)}"`)
if (updated === src) fail(`couldn't find "version": "${format(current)}" in ui/package.json to replace.`)
writeFileSync(PKG, updated)

console.error(`→ releasing v${format(next)}`)
console.log(format(next))
