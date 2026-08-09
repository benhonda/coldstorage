---
name: docs-master
description: The rules for touching ANY documentation — trigger the moment you're about to create or edit a doc file (README, CLAUDE.md, any *.md, a docs-site page, a handoff/notes/status file), mid-task or at wrap-up, no special phrasing required; the file path alone is reason enough. Core rules it enforces — default number of NEW doc files is zero, handoff docs stay under ~200 lines, point at code/git instead of restating it, never hand-edit generated docs. Also the full checkpoint flow — reconcile every doc surface against what the code/git actually say now, kill stale references, and capture ongoing + planned work where it belongs so a fresh agent can resume without losing the thread — WHENEVER wrapping up a session, pausing mid-feature, handing off, running low on context, or the user says "checkpoint", "leave a clean state", "update the docs", "hand this off", or "save progress". Exception — writing a spec/plan/PRD itself is spec-driven-dev's job — but this skill still governs whether that file should exist at all.
model: claude-sonnet-5
effort: low
---

A checkpoint is a clean save-point: the repo's docs tell the truth about where things stand, no reference points at something that moved or died, and the next agent can find ongoing + planned work — then **verify it themselves** rather than trust it. You're writing for a skeptic who will (rightly) confirm before acting. Don't make them sift fiction.

**Two modes.** Invoked mid-task because you're about to touch a doc file: apply the standing rules — zero new doc files by default, ~200-line ceiling, point don't restate, respect generators — to that one edit and get back to work. Invoked at wrap-up/handoff: run the full flow below.

## The mindset

The docs already in the repo are **suspects, not witnesses.** They were true when written; they may not be now. Your job is to reconcile them against ground truth — the code, the git history, the tests — and leave them honest. That same skepticism is what you're enabling downstream: write so the next agent treats your notes as *leads to confirm*, not gospel. The fastest way to do that is to point at the source (`see src/auth/session.ts:40`) instead of restating it in prose that will rot.

## Establish ground truth first

Before touching a doc, find out what's actually true — don't open the docs and trust your way forward from them. **Run these live, right now** — an earlier result already in this session's transcript doesn't count; the tree can have moved since.

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

**The default number of new doc files is zero.** Every hand-maintained file you create is a stale doc in waiting — the failure mode isn't too few docs, it's a scatter of `NOTES.md` / `PLAN.md` / `STATUS.md` files that are outdated the moment the next commit lands. Fold updates into surfaces that already exist; if something must be derivable, prefer a generator/SSOT over prose. A genuinely needed handoff doc the repo lacks is **one** file, not several.

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
- **The record of what shipped isn't yours** — that's the commit log, owned by the add-and-commit skill. A checkpoint reconciles docs against ground truth; it never logs changes. Never write a `CHANGELOG.md` entry — git is the SSOT; leave any existing changelog alone.
- Follow the repo's doc conventions (where things go, format). When in doubt, match what's already there.

## Write honest, verifiable notes

- **Smallest footprint that stays true, at a glance.** A checkpoint is a marker, not a task-by-task ledger — it doesn't accrete. A handoff doc should stay under ~200 lines, and most belong well under that — past there you're restating what code/git already carry. If a surface is already honest, leave it untouched; net doc length should fall as often as it rises. Track workstreams, not every sub-task inside them: don't itemize each small step as done/pending unless the user explicitly asked you to track it that granularly — that's exactly the level of detail that goes stale first and turns a checkpoint into noise. Never paste walls of status prose a `git log` already carries.
- **State true status, including ugly.** Half-done is "half-done, blocked on X at file:line" — never rounded up to done. Fabricated completeness is the one thing that makes a checkpoint actively harmful.
- **Point, don't restate.** Anchor claims to `file:line`, a commit SHA, a test name. Prose drifts; references can be checked.
- **Never write git state into a doc.** "Uncommitted", "unpushed", "not yet applied" are live readouts, not facts — void the moment someone commits, sometimes while you're still typing (if the user says "I'm committing this now", that's the truth: write as if done, or say nothing). Git is its own SSOT and the reader gets the current answer in one command, so a doc's claim is at best redundant, at worst a stale alarm the next agent dutifully obeys. If in-flight work matters to the handoff, describe the *work*, anchored to immutable refs (SHA, `file:line`) — never to working-tree status.
- **Do it now, don't track it.** Pending operational steps (`db push`, `terraform apply`, and the like) get surfaced to the user and resolved on the spot during the session — never parked in a doc as tracked tasks unless the user explicitly asks. Likewise never leave "verify visually" / "run the dev server and check" items or ask the user to boot a dev server to confirm work: verify what you can yourself (typecheck, tests) and flag the rest as uncertainty.
- **Flag uncertainty inline, never as a list.** Attach it to the claim it qualifies, anchored to what you *did* check — "TTL is 30m (read at `src/auth/session.ts:40`, didn't exercise it)" — so it dies when the claim does. Never a standing "things to verify / not verified" section: nothing can grep it false, so the stale-reference hunt above can't catch it and nobody ever prunes it. What you couldn't check at all goes in the close-out message, not the doc.
- **Date and attribute** time-sensitive notes so the next reader knows how stale they might be.

## Close out

Briefly tell the user what you reconciled, what stale references you killed, where ongoing/planned work now lives, and anything you couldn't verify (so they know the soft spots). Don't commit unless asked — leaving the working tree clean and the diff reviewable is itself part of the handoff.
