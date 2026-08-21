# Project shell — vite, tsconfig, react-router config

The build/config layer that makes everything else compile and run: the `~/*` alias, the RR + Tailwind v4 wiring, and the **auto-generators** that keep the codegen outputs fresh. Without this, the engines don't resolve imports and the generated files never get produced.

**Read when:** bootstrapping a new app, or anything fails to resolve `~/...` / generated files.

## Contract
- A project has three root config files: `vite.config.ts`, `tsconfig.json`, `react-router.config.ts`.
- The `~/*` import alias maps to `app/*` (tsconfig `paths` + the Vite tsconfig-paths plugin).
- Code generators run **two ways, same scripts**: automatically via the Vite `auto-generators` plugin (on dev-server start + build, re-running on file changes), and via `task generate` (which `task typecheck` depends on) for typecheck/CI. The pipeline is owned by `references/taskfile.md`.

## Non-negotiables
| key | rule | why |
| --- | --- | --- |
| shell-files | ship `vite.config.ts`, `tsconfig.json`, `react-router.config.ts` at the project root | nothing resolves or builds without them |
| alias | `~/*` → `app/*` via tsconfig `paths` (for tsc) **and** Vite `resolve.alias` (for bundling) — `vite-tsconfig-paths` is **deprecated**, don't use it. **No `baseUrl`** — TS 6 deprecates it and TS 5+ resolves `paths` relative to the tsconfig dir; don't re-add it | every engine imports `~/lib/...`, `~/hooks/...` |
| include-generated | tsconfig `include` carries `.react-router/types/**/*` and `rootDirs` lists it | RR route typegen + generated files are in the program |
| auto-generators | keep the Vite `auto-generators` plugin (dev + build); it complements `task generate` | devs never hand-run codegen after adding an action/route/schema/env |
| types-minimal | tsconfig `types` baseline is `["node", "vite/client"]` — add `"bun"`, `"youtube"`, etc. only if the app actually uses them | extra entries error with "Cannot find type definition file" in a fresh app |
| runtime-dep-node | `@react-router/node` is a **runtime** dependency, not a dev one | as a devDependency `react-router typegen` dies with "Could not determine server runtime" |
| per-route-function-config | per-route `maxDuration`/`memory` comes from **`export const config = { maxDuration: 20 }` in the route module**, which `vercelPreset()` compiles into its own hashed `build/server/nodejs_<base64-config>` bundle — verify by checking a second bundle appears. **Not** `vercel.json`'s `functions` key: that only globs an `api/` directory and fails the build outright with *"doesn't match any Serverless Functions inside the `api` directory"*. Treat it as a backstop and bound outbound calls in code too (`AbortSignal.timeout`), since the project default ceiling is often 300s | the `vercel.json` error names `api`, which reads like a wrong-framework problem and sends you hunting in the wrong place; and a timeout you *think* you set is worse than none |
| fresh-app-ok | a brand-new app has zero actions; the action-map generator emits `ActionName = never` (valid) | first `task generate`/`typecheck` passes before you write any action |
| bootstrap-prompts | when scaffolding, **ask** whether the app lives at the repo root or in a subdir, and **recommend a name** from `.devcontainer/devcontainer.json` (its `name`) | genuine project-structure choices — worth asking (unlike decided conventions); the name isn't guessable |

## Engine — copy faithfully (→ project root)
`assets/vite.config.ts`, `assets/tsconfig.json`, `assets/react-router.config.ts`. The Vite config is curated (no EventBridge generator). Treat the plugin wiring as setup-you-verify (plugin APIs drift — see below); keep the `auto-generators` plugin + the `generators` list intact, trimming entries only for subsystems the app doesn't use.

## Bootstrapping
Two upfront choices — these genuinely vary, so **ask, don't assume**:
1. **App at the repo root, or in a subdirectory?** Standalone RR app → root; a monorepo (RR app alongside other packages) → a subdir (e.g. `web/`). Put the whole shell there: `app/`, the three config files, `infra/`, and this app's own `.env`/`.env.vercel` — the Taskfile stays one root file (`references/taskfile.md`'s `assembled-one-file`), with this app's tasks dir- and `dotenv`-scoped to the subdir (`per-app-dotenv`).
2. **Project name** — if `.devcontainer/devcontainer.json` exists, recommend its `name` (used for the package name + the terragrunt state key); confirm with the user.

Then start from the current React Router template, overlay the three config files (and the other subsystems' assets), and run `task generate` before `task typecheck`.

## Verify at latest
- **@react-router/dev**, **@tailwindcss/vite**, **vite-plugin-devtools-json**, **zx** — confirm current plugin names/APIs. Resolve the `~` alias with Vite `resolve.alias` (not `vite-tsconfig-paths`, which is deprecated).
- RR's typegen output dir (`.react-router/types`) and the template's baseline tsconfig.
- Native deps that break client bundling may need `optimizeDeps.exclude` (e.g. argon2).
