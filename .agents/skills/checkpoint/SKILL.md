---
name: checkpoint
description: Leave the repo in a clean, pick-up-able state — reconcile every doc surface against what the code/git actually say now, kill stale references, and capture ongoing + planned work where it belongs so a fresh agent (or future you) can resume without losing the thread. Use this WHENEVER wrapping up a work session, pausing mid-feature, handing off, running low on context, or the user says "checkpoint", "checkpoint this", "leave a clean state", "update the docs", "make this pick-up-able", "snapshot where we are", "hand this off", or "save progress so someone can continue". Reach for it even when they don't say "docs" — the goal is a faithful, verifiable handoff, not just prose touch-ups.
model: claude-haiku-4-5-20251001
---

A checkpoint is a clean save-point: the repo's docs tell the truth about where things stand, no reference points at something that moved or died, and the next agent can find ongoing + planned work — then **verify it themselves** rather than trust it. You're writing for a skeptic who will (rightly) confirm before acting. Don't make them sift fiction.

## The mindset

The docs already in the repo are **suspects, not witnesses.** They were true when written; they may not be now. Your job is to reconcile them against ground truth — the code, the git history, the tests — and leave them honest. That same skepticism is what you're enabling downstream: write so the next agent treats your notes as *leads to confirm*, not gospel. The fastest way to do that is to point at the source (`see src/auth/session.ts:40`) instead of restating it in prose that will rot.

## Establish ground truth first

Before touching a doc, find out what's actually true — don't open the docs and trust your way forward from them.

- `git status` + `git diff` — what's uncommitted, in-flight, half-done.
- `git log` since the last clean point — what actually shipped vs what the docs claim.
- If cheap and the repo supports it, run the typecheck / tests so the checkpoint records *real* state, not assumed state. A checkpoint that says "all green" when it isn't is worse than no checkpoint.
- Separate the three things a fresh agent needs: **what's done**, **what's in progress** (and where it stalled), **what's planned next**.

## Discover the doc surfaces — this repo's, not a generic list

You have context on what this repo is doing and what changed. Use it. There's no fixed set — find the surfaces that exist here and matter to what moved:

- Root + nested `CLAUDE.md`, `README.md`, per-package docs, a docs site, generated reference docs.
- A handoff/checkpoint/notes doc **if the repo already keeps one** — update it; don't resurrect one the repo deliberately dropped.
- In-code TODOs, FIXMEs, and comments that narrate intent.
- An external tracker (issues, Asana) if that's where this team's planned work lives.

Route each update to where it belongs. If ongoing work naturally lives in a TODO next to the code, put it there — not in a separate file. If the repo wants a checkpoint doc, write one. Let the repo's existing habits decide; don't impose an artifact it doesn't use.

## Hunt stale references — the verifiable core

"No stale references" is the part you can actually check, so check it. Stale = a doc points at something that moved, was renamed, retired, or changed shape:

- **Dead paths / names** — file, dir, function, command, env var, flag, or route that the doc names but no longer exists or got renamed. Grep the referenced name; if it's gone, the doc is lying.
- **Drifted commands** — setup/build/run/test instructions that changed (script renamed, flag dropped, `npm`→`bun`).
- **Stale counts & versions** — "3 skills", "supports X and Y", a pinned version or date that the tree no longer matches.
- **Retired patterns** — a doc still teaching an approach the code abandoned. This is the dangerous kind: it actively misleads. Fix or delete it.
- **Broken internal links** — `@path` references and relative links that 404.

When you fix one, fix it at the source of truth and let derived/generated docs regenerate — don't hand-patch a generated file (see below).

## Respect generators & ownership

- **Never hand-edit a generated file.** If a file carries a "generated" banner or the repo derives it from inputs, edit the *input* and note that a rebuild is needed (or run the generator). Hand-patching generated output is stale-reference debt waiting to happen.
- **Don't overwrite docs you didn't write without reading them first.** If a doc contradicts what you found, that's a flag to surface — maybe you're wrong, maybe it's stale. Investigate before bulldozing.
- **The CHANGELOG (and commit log) isn't yours** — logging what shipped belongs to the add-and-commit skill. A checkpoint reconciles docs against ground truth; it never writes changelog entries. Leave `CHANGELOG.md` alone.
- Follow the repo's doc conventions (where things go, format). When in doubt, match what's already there.

## Write honest, verifiable notes

- **Smallest footprint that stays true.** A checkpoint edits in place and deletes stale — it doesn't accrete. If a surface is already honest, leave it untouched; net doc length should fall as often as it rises. Never paste walls of status prose a `git log` already carries.
- **State true status, including ugly.** Half-done is "half-done, blocked on X at file:line" — never rounded up to done. Fabricated completeness is the one thing that makes a checkpoint actively harmful.
- **Point, don't restate.** Anchor claims to `file:line`, a commit SHA, a test name. Prose drifts; references can be checked.
- **Flag your own uncertainty.** "I believe X but didn't confirm" tells the next agent exactly where to start digging. That's a feature.
- **Date and attribute** time-sensitive notes so the next reader knows how stale they might be.

## Close out

Briefly tell the user what you reconciled, what stale references you killed, where ongoing/planned work now lives, and anything you couldn't verify (so they know the soft spots). Don't commit unless asked — leaving the working tree clean and the diff reviewable is itself part of the handoff.
