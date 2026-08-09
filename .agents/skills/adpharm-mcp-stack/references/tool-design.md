# Tool design — surface shape, descriptions, and companion docs

Owns how the tool surface is designed, described, and kept honest — for either variant.

**Read when:** deciding what tools to expose, writing/editing a tool or its description, adding server `instructions`, or shipping any doc/skill that describes the server.

## Contract

Two valid shapes, chosen per surface — don't cargo-cult either:

- **Goal-shaped tools** (the adapts-mcp shape): tools map to user intentions (`create_tracking_link`), not tables. ~10–20 for a v1: `whoami`, a few paged+searchable `list_*`, entity CRUD, one read-only stats tool.
- **Constrained primitive** (the silo-cdp-mcp shape): when the caller is an analyst whose intentions are unbounded, the model is better at composing the query than you are at predicting it — expose *one* primitive and constrain it hard (read-only role, `READ ONLY` transaction, statement timeout, row cap, true-count-when-capped).

## Non-negotiables

| key | rule | why |
| --- | --- | --- |
| cap-in-the-query | cap result sets **in the query** (`SELECT * FROM (<sql>) _q LIMIT <cap>+1`), not after, and report the true total separately | a Worker has ~128 MB and a result set doesn't respect that; a visibly-capped result is also the "you forgot to aggregate" signal |
| names-mean-not-source | name output fields for meaning, not source (`clicks`, not `gaClicks`) | source names go stale the day the source changes, and renaming is then an output-contract change |
| instructions-server-level | cross-tool guidance goes in server-level `instructions`, not buried per-tool: workflow order (`whoami` → `list_*` first), "mutations are live immediately", "confirm before deleting", "ask the user for naming-convention values (e.g. UTM fields) rather than inventing them" | per-tool burial means the model sees it only after picking the tool |
| collision-guidance | uniqueness/collision guidance lives in descriptions ("list first to avoid path collisions") | cheap prompt-side guardrails beat error round-trips |
| two-step-uploads | file uploads are two-step: `create_file_*` returns a pending row + presigned PUT URL (the *agent* uploads the bytes), then `confirm_*` **HEAD-verifies** the object landed before activating | stricter than trusting a client success flag; only works from clients that can execute an upload (CLI yes, browser no) |
| generated-tool-lists | any human-facing tool list is generated from the Worker's registrations, or carries a CI drift guard | the reference build's hand-kept `/mcp` page has a "keep in sync" comment — that's a standing drift liability, not a pattern |

**Conditional registration** (have the server factory register only the tools the caller's role can use, so the model never sees the rest) is the right instinct but **untried in both reference builds** — adapts registers all 16 unconditionally behind a single route-level role gate, which is fine when everyone who can connect at all may use everything. Reach for conditional registration only when connectable roles genuinely diverge; don't claim it's proven.

## Engine

None — tool definitions are app domain. (The safety wrapper behind a constrained primitive is Shape in `variant-a-direct-gateway.md`.)

## Shape — companion skills/docs are part of the surface

If you ship a skill teaching a model to use the server, it drifts from the schema it describes unless something fails. The silo-cdp-mcp mechanism, generalized:

- **One physical SSOT, symlinked editions.** The real reference files live once; per-client editions (claude.ai upload vs CLI) hold symlinks plus only their genuinely edition-specific files (`SKILL.md`, `transport.md`). Never replace a symlink with a real copy — that re-creates the fork the structure exists to prevent.
- **Generated docs are vendored with a banner + a check task.** `mcp:schema:pull` copies the generated source and prepends a DO-NOT-EDIT banner; `mcp:schema:check` regenerates into a tempfile and `diff -u`s — catching *stale* and *hand-edited* in one shot — **and runs in CI**. Any doc describing a live schema needs this, or it will lie: quietly, and only to the model.
- **Validate skill frontmatter before packaging** (real YAML parse, not eyeballs) — an unquoted colon in a `description:` has already broken a claude.ai upload once.

## Verify at latest

- Current tool-registration API (`registerTool` signature and its metadata fields — including where `instructions` now lives). The v2 package split and the deprecated-overload trap are owned by `shared-core.md` § Verify at latest.
- claude.ai/Claude Code current limits on tool count and description length, if the surface is large.
