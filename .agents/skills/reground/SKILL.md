---
name: reground
description: Reread every CLAUDE.md governing this session — global user instructions, the project root, any nested/per-package ones, and anything they @-import — so pillars and rules that have scrolled out of context (or gotten fuzzy after a long session) are back at full strength. Explicitly invoke on "/reground", "reground yourself", "reread your CLAUDE.md files", "recheck your instructions", or "are you still following the guidelines". Just as important — self-invoke proactively, without being asked, whenever the conversation has gone long and deep — heavy back-and-forth, many tool calls, a context compaction happened, or it's simply been a good while since instructions were last read in full. Err toward regrounding too often rather than too rarely; it's cheap insurance against drift.
---

Reread the CLAUDE.md files that govern this session, in full, using the Read tool — not from memory, and not from a compacted summary, since compaction is exactly the kind of event that quietly erodes fidelity to the original wording.

## What to read

Find every CLAUDE.md relevant to the current session:

1. **Global user instructions** — `~/.claude/CLAUDE.md`.
2. **Project instructions** — the `CLAUDE.md` at the repo root, and at the root of whatever project you're currently working within if this is a monorepo.
3. **Any nested CLAUDE.md** on the path between the repo root and the file(s) you're currently editing — monorepos and per-package setups often layer these.
4. **Anything those files `@import`** (e.g. `@global-CLAUDE.md`) — follow the reference and read the imported file too, not just the line that mentions it.

Use Glob/Read to locate these rather than assuming a fixed set — the point is to catch whatever actually applies to *this* session, not a hardcoded list.

## After reading

Briefly tell the user you reground — which files, in one line — then carry on with the task. This is invisible work otherwise, and a one-line note costs nothing. No need to summarize the contents back or restate the pillars; just confirm you refreshed them and continue.
