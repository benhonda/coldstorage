---
name: audit-code-quality
description: |
  Audit code you (or another agent) just wrote against our engineering pillars — read fresh from CLAUDE.md, which is their SSOT — then FIX what it finds and tie off every loose end: TODOs, stubs, half-done branches, dead code, docs left stale. Explicitly invoke on "/audit-code-quality", "audit this", "audit the code", "review your work", "check this against the pillars", "did you follow the guidelines", "is this up to standard", "any loose ends", "clean this up", "anything unfinished", "did you kick the can". Just as important — self-invoke proactively, without being asked, whenever a non-trivial implementation is finished or a feature/refactor/migration is about to be reported as done, before committing a meaningful chunk of work, when picking up work another agent left mid-flight, or after a long build where earlier decisions may have drifted. This audits and FIXES code already written; to re-read the CLAUDE.md rules and check a plan against them before any code exists, use reground instead.
---

Audit your implementation against the engineering pillars defined in the user-level CLAUDE.md. Then, tie-off any loose ends in the implementation that you are auditing. After, let the user know what is needed of them, if anything.

Notes for you:

- Read the user-level CLAUDE.md fresh so this audit never drifts from the source.
- If your implementation is extensive in nature, use agents as you see fit.
- It's ok if there is genuinely nothing to fix - just ensure you aren't "kicking the can" and violating PILLAR2. That's why this skill requires your intelligence.
- If the fixes you suggest are unequivocally correct, just do it.
