---
name: spec-driven-dev
description: 'Run spec-driven development without letting the spec calcify into scripture. Use this WHENEVER scaffolding a new project or feature, writing or updating a spec / plan / PRD / design doc / roadmap, when the user says "let''s plan this out", "scaffold X", "spec this out", "write up a plan", "design this", OR — just as important — when picking work back up against a spec/plan that already exists in the repo. It covers the format that keeps specs honestly provisional, the drift-check that stops you executing stale instructions, a hardest-first phasing rule that refuses to defer the difficult work, and the altitude needed to keep solving the real goal instead of obeying a document. Reach for it even when the user does not say "spec" — any "let''s build/start/scaffold something new", "break this into phases", or "continue the plan" moment qualifies.'
---

Spec-driven development goes wrong when the spec gets treated as scripture. It isn't. A spec records what we believed **when we wrote it** — days or weeks ago, mid-figuring-it-out, together. The goal moves. The spec doesn't, unless you make it. This skill is for **writing specs that announce their own provisionality** and for **working against them without going on autopilot.**

## The trap

You write a spec on day 1. On day 12 you're deep in the build and the spec says "dogfood it, stand up test infrastructure, validate end-to-end." But the live goal has become "get this to production so we can test it there." A spec-as-scripture agent reads the doc, sees the instruction, and dutifully builds the testing scaffold nobody now wants — burning tokens to delay the actual goal. The spec said necessary; it didn't say *sufficient*. **The instruction existing is not a reason to follow it.** The reason to follow it is that it still serves what we're trying to do right now.

This is the same skepticism the `checkpoint` skill applies at wrap-up — *docs are suspects, not witnesses.* This skill is the creation-side dual: write the spec so it admits up front that it's a suspect, and treat it like one while you build.

## Write specs as drafts, not contracts

Every spec/plan/PRD this skill produces opens with a status banner — verbatim shape:

```
> **Status: EXPLORING** · 2026-06-29 · provisional
> Records our thinking as of the date above — NOT a contract. Before acting on anything
> here, confirm it still matches the current goal. When it conflicts with where we're
> actually headed now, the current goal wins: flag the conflict, don't silently obey.
```

- **Status ladder** — `EXPLORING` (still figuring it out, expect churn) → `DRAFT` (shape agreed, details soft) → `SETTLED` (decided; change only deliberately, and bump the date when you do). Default new specs to `EXPLORING`. Nothing is `SETTLED` until the user and the work both confirm it — don't promote it yourself to feel finished.
- **Tag decisions, not just the doc.** Inline-mark individual calls: `[settled]`, `[open]`, `[assumption]`. This separates the load-bearing from the placeholder so a later agent knows what it may freely revisit. A wall of unmarked prose reads as all-settled — that's the trap.
- **Date everything time-sensitive**, in absolute dates (today is in the env context). "Recently" rots; `2026-06-29` doesn't.
- **Capture the why, briefly.** A decision with its reason can be re-evaluated when the reason changes. A bare decision just looks like law.

## Working against an existing spec

Before you act on any spec item, run a two-second altitude check: **does this still serve what we're trying to do right now?**

- If yes — proceed, no ceremony.
- If it's drifted — **stop and surface it at the decision level**, don't silently obey and don't silently skip: *"Spec says X (written 2026-06-17, status DRAFT). We now seem to be aiming at Y, which makes X look stale — confirm before I follow it?"* Then, once resolved, **update the spec's status/text so it stops misleading the next agent.** A stale line you worked around but left in the doc is a trap you re-armed.
- Specs are **leads, not orders.** Necessary, not sufficient. The current goal always outranks the written one.

This is where "are you sure?" bites hardest, weeks deep. The behavioral rules are SSOT in root `CLAUDE.md` — re-read them, don't restate them: a question is a request to re-examine (defend-or-revise with reasoning), not a verdict; don't cave; solve the *actual* problem rather than rabbit-holing into adjacent work; report back at the user's altitude. A spec-driven build is a long arc — protect the altitude across all of it, because that's exactly where it erodes.

## Scaffolding a new project or feature

- Lead with the **goal and the open questions**, not a finished blueprint. At `EXPLORING`, the most valuable thing the spec holds is what's *undecided* — make those explicit so they get resolved instead of silently defaulted.
- Don't over-build the plan. The spec is a thinking tool we co-edit, not a deliverable to impress with. Match its depth to how settled the work actually is.
- Follow the repo's real conventions and the 4 pillars when you do start building — but keep the spec and the code honest about which parts are still soft.

## Phasing: hardest-first, never kick the can

Phasing isn't the problem — *easy-first* phasing is. Knocking out cheap, satisfying work early and deferring the hard, uncertain, load-bearing parts to "a later phase" is the cheap-win / can-kick pillar 2 forbids. It *feels* like progress and produces the opposite: a foundation built around decisions you haven't actually made yet, which you then rip out or live with wrongly shaped.

Don't abolish phases — **invert the ordering:**

- **First slice goes through the hardest, most-likely-to-be-wrong part** — the thing that, if wrong, invalidates everything on top: the real data model, the auth boundary, the integration you're unsure works, the perf-critical path. Prove a thin end-to-end "steel thread" before fleshing out the easy layers. De-risk early; the cheap stuff has no unknowns, so it waits.
- **Defer scope, not quality.** "Feature X lands in phase 2" is legit. "We'll do X properly in phase 2 — hack a fake one for now" is the trap. Each phase builds the *real* thing for its scope, at quality. Less surface, never lower standard.
- **Name the hard parts up front so they can't hide.** List the risky/uncertain decisions in the spec, tied to `[open]`/`[assumption]` tags. Anything unnamed is what gets silently punted to a phase that conveniently never arrives.
- **A phase ends sound, not staged-for-rework.** If phase N requires demolishing phase N-1, the slices were cut wrong — re-cut them. Vertical (a thin slice that actually works) beats horizontal (a whole cheap layer that does nothing yet).

**Hard ≠ heavy — and de-risking ≠ building test infra.** This rule sits in deliberate tension with **The Trap** above; hold both. Hardest-first means the riskiest *product/architecture* slice (the real data model, the integration, the load-bearing call) — NOT standing up test harnesses, dogfooding rigs, or speculative abstractions first. "Quality" is the real thing built right, not ceremony wrapped around it; "defer scope not quality" is not a mandate for test coverage or infrastructure. Often the cheapest way to de-risk the steel thread is to ship it into the real environment and watch it — production *is* a de-risking move — rather than construct infrastructure to simulate that. So: hardest-first licenses confronting the hard *product* decision early; it never licenses the testing/polish rabbit hole that delays getting to production. Right-size ancillary work to the current goal, and never let it become displacement from shipping. The test for both: *does this move the real goal forward, or does it just feel productive?*

Throwaway prototypes are fine — but only when **labeled throwaway and actually thrown away.** A spike to learn the hard part is good engineering; silently promoting that spike to the foundation is the can-kick in disguise. Mark it provisional (above) so the next agent doesn't mistake scaffolding for the building.

## Handing off

When you pause or wrap, use the **`checkpoint`** skill to reconcile the spec against what the code actually does now and bump its status accordingly. A `SETTLED` spec the code already diverged from is precisely the stale-scripture trap the next agent will walk into — leave it reconciled, not aspirational.

---

**tldr:** A spec is provisional thinking, not law. Write it with a status banner + dated, tagged decisions so it admits that. Before executing any spec item, check it against the *current* goal — flag drift, don't obey it blindly, and update the doc when it's stale. Phase hardest-first — defer scope, never quality; no can-kicking. Keep altitude and don't cave (see `CLAUDE.md`); hand off via `checkpoint`.
