---
name: add-and-commit
description: Add and commit changes, update readme.
model: claude-sonnet-5
effort: low
---

Quick add + commit of ALL pending changes (except out of scope below). **No typecheck, no fix, no lint** — this is a stenographer, not a reviewer. Keep it quick. Changes may be ongoing - be aware.

File locations: @README.md

## What to do

1. Run `git status` + `git diff` now — a live call, never a memory or an earlier result from this session; the tree may have moved since. Cover the whole tree, not just cwd. **Dotfile config dirs count** — `.devcontainer/`, `.claude/`, `.agents/` and the like are in scope; don't skip them as "not code" or mistake them for scratch.
2. Group the diff into logical commits. **Break it up if the changes are unrelated** — separate concerns get separate commits. One commit if everything coheres.
3. For each commit: stage the relevant files by name (no `git add -A`), commit.
4. Update README.md only if a pending change makes it factually wrong. Don't polish it.

## Commit messages — the record

`git log` is the SSOT for what shipped. **Never write a CHANGELOG.md entry** — no hand-maintained duplicate of the history. The first time you meet a live-looking CHANGELOG.md in a repo, close it out: one line under the H1 — `> **Closed.** Kept as history only — \`git log\` is the SSOT for what shipped. Don't append.` — then never touch that file again. Never delete it; the history stays readable. Where a published package genuinely needs a changelog, it's generated from these commits, not typed.

That puts the whole quality bar on the message:

```
fix: FlowStoryboard skyline-packs branches so sibling sub-flows stop overlapping
```

**Prefixes:** `feat:` `fix:` `refactor:` `docs:` `chore:`

**Rules:**

- Subject = type prefix + the named artifact (component, route, file, flag) + what changed. No vague "improved X".
- Keep the subject to one line, ~120 chars. When it won't fit, that's a **body**, not a longer subject — blank line, then the detail.
- Body only when the subject can't carry it: a non-obvious why, a gotcha, a carry-back from a downstream fix. Not an essay; the diff is right there.
- In a monorepo, name the project the change lands in so the log stays scannable per-project.

## Breaking up commits

Examples of when to split:

- Design-system change + an unrelated docs update → two commits.
- Bug fix + a new feature on a different surface → two commits.
- Skill/tooling chore mixed with product code → split the chore out.
- Changes in two different projects of a monorepo → split per project.

Don't split for the sake of it. A feature that touches 8 files is still one commit.

## Out of scope

- ❌ typechecking, lint, formatters, test runs
- ❌ "fixing things up while I'm here"
- ❌ pushing to remote
- ❌ creating PRs
- ❌ Untracked files that look like scratch/temp (`Untitled-*`, `*Write-up*.md`, cloned reference repos, personal notes) — leave them, note in the wrap-up. Ask only on genuinely ambiguous in-progress dirs.
