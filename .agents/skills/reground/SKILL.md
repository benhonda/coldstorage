---
name: reground
description: Reread every CLAUDE.md governing this session — global user instructions, the project root, any nested/per-package ones, and anything they @-import — so pillars and rules that have scrolled out of context (or gotten fuzzy after a long session) are back at full strength. Explicitly invoke on "/reground", "reground yourself", "reread your CLAUDE.md files", "recheck your instructions", "are you still following the guidelines", or as a final check on a plan before building — "does this plan follow the pillars", "reground before you start". Just as important — self-invoke proactively, without being asked, whenever the conversation has gone long and deep — heavy back-and-forth, many tool calls, a context compaction happened, or it's simply been a good while since instructions were last read in full. Err toward regrounding too often rather than too rarely; it's cheap insurance against drift. It rereads the instructions and holds the plan you're about to execute up against them; it does not review or fix code already written this session — for that, use audit-code-quality.
---

Reread the CLAUDE.md files that govern this session, in full, using the Read tool — not from memory, and not from a compacted summary, since compaction is exactly the kind of event that quietly erodes fidelity to the original wording.

## What to read

Find every CLAUDE.md relevant to the current session:

1. **Global user instructions (MOST IMPORTANT, CONTAINS OUR PILLARS)** — `~/.claude/CLAUDE.md`.
2. **Project instructions** — the `CLAUDE.md` at the repo root, and at the root of whatever project you're currently working within if this is a monorepo.
3. **Any nested CLAUDE.md** on the path between the repo root and the file(s) you're currently editing — monorepos and per-package setups often layer these.
4. **Anything those files `@import`** (e.g. `@global-CLAUDE.md`) — follow the reference and read the imported file too, not just the line that mentions it.

Use Glob/Read to locate these rather than assuming a fixed set — the point is to catch whatever actually applies to _this_ session, not a hardcoded list.

## After reading

Hold whatever you're about to do — the plan you just proposed, the next edit, the approach you're mid-way through — up against what you just reread, and close any gap _before_ writing code: a plan that quietly breaks a pillar becomes code that breaks it. Where it's off, say which pillar/rule and what you're changing in a line or two, then proceed on the corrected plan — not the old one.

Then tell the user you reground — which files, in one line — and carry on with whatever you were already doing. This is invisible work otherwise, and a one-line note costs nothing. No need to summarize the contents back or restate the pillars.

Reground checks the instructions and the plan ahead; it never reviews or fixes code already written this session. If the user wants that, point them to `audit-code-quality`.
