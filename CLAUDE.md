# Agentic Engineering Guidelines

You are an expert who double-checks things, you are skeptical, and you do research. I am not always right. Neither are you, but we both strive for accuracy.

> **START HERE (orientation):** read [`ROADMAP.md`](./ROADMAP.md) first — it's the one-screen map of what's real, what's stubbed, what's next, plus dev-env gotchas. Then this file (how we work) + the auto-loaded memories (decisions in force). Keep ROADMAP.md current as you finish work.

---

## Our 4 pillars of great engineering - your foundation

We design solutions that are:

1. Simple (not necessarily "easy", because often complex = easier and simple = harder)
2. Best-practice-following (no cheap wins or "kicking the can")
3. DRY (minimize code duplication, opting for a SSOT solution where possible)
4. Type-safe (let static type checking relieve the maintenance burden, type-casting only as a last resort, definitely no `as any`, leverage /typescript-advanced-types skill where applicable)

## Core Principles - your holy commandments

- **ALWAYS reference & follow our 4 engineering pillars:**
- **ALWAYS provide a recommendation:** options are good - it shows your thinking things through - but they must come with a recommendation from you (and that recommendation should be grounded in truths and facts, not assumptions)
- **BE CONCISE:** SACRIFICE GRAMMAR FOR CONCISION.
- **Inline comments are encouraged:** Always consider using inline and jsdoc-style comments where appropriate.
- When you add dependencies, add the latest (i.e. `bun add <package name>@latest`) - DO NOT manually add to `package.json`.
- We do work on the same codebase with multiple agents - if you notice mid-implementation work that isn't yours, flag it, DO NOT revert it.
- **It's 2026, code like it:** Research current standards. For any new technology, library, or pattern, perform a web search to ensure you are using modern best practices for the current year (2026).
- **Use the Taskfile for EVERYTHING:** We use a single root `Taskfile.yml` to run servers, scripts, and processes - even one-offs. This is preferred vs. "bun run" commands (or similar) because it loads in env vars, aws auth, and more.
- **The user will add & commit on their own, usually via a dedicated skill run:** do not offer to commit or create PRs during sessions.
- Detailed explanations are good for complex problems, but always include a tldr at the end
- If we have docs (or a docs site), keep 'em up to date. It's fine to do this after-the-fact, but just don't forget. Generators preferred over hand-maintained docs.
- When writing tests, ensure they test something real (ideally real code), and are not facade.
- Write memory as a last resort. There's usually a better place to put lessons so that it carries over from agent to agent and developer to developer.

## DO NOT DO THESE EVER

- **Never Hallucinate:** If you are uncertain about any detail, ask the user for clarification. Do not invent information.
- **Never Assume User Intent:** When unclear, always confirm your understanding of the user's goal before taking action or writing code. The user often asks genuine questions - NEVER assume this to be evidence that the user disagrees with your solution/proposal.
- **No backwards compatibility or fallbacks baked-in:** Unless explicitly told to do otherwise, never maintain backwards compatibility in development, and don't add fallbacks.
- **No DB migration files or direct schema pushing:** Never create an SQL migration or push a drizzle schema directly without explicit permission. The user typically does this themselves.

---

## Project-specific settings

### Project-specific holy-commandments additions

- For JS/Node, we use Bun. Not NPM.
- For IaC/Terraform/Terragrunt, you should verify & debug any sizable changes with the plan, though you never apply. See taskfile for exact commands. Assume you are logged into profile 'pharmer' unless proven otherwise
- You have access to all our silo services
- This is a PUBLIC REPO - no sensitive stuff please!

### Monorepo structure

Currently one product, **ColdStorage** (see [`ROADMAP.md`](./ROADMAP.md) for the full picture):

- `coldstorage/` — the Swift package: portable `ColdStorageCore` (engine, journal, crypto, control plane) + `ColdStorageMac` adapter (PhotoKit, FSEvents) + executables (`coldstored`, `coldstorectl`, `coldstore-cli`, `coldstore-restore`). Has its own `README.md`.
- `infra/coldstorage/` — Terraform/Terragrunt for S3 GDA + lifecycle + least-priv daemon IAM (Taskfile `tf:coldstorage:*` wired; **scaffolded, `validate`-clean, and APPLIED vs real AWS** — prod vault + IAM user live. R2 still deferred until the thumbnail view needs it).
- `phase0-upload-spike/`, `phase0-photos-spike/` — de-risking spikes (seeds of the core; photos spike un-run, needs a Mac).
- `Taskfile.yml` — the single root command surface (`daemon:*`, `tf:coldstorage:*`). Use it for everything.
- `UPLOAD-DAEMON-DESIGN.md`, `daemon-module-split.md` — design docs (engine spec; portable/Mac split).
- `strategy/` — **gitignored, private**: product spec, brand voice, economics. Not in the public repo.
