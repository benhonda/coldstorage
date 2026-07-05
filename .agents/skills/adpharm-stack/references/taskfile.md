# The Taskfile (core)

`task` is the command surface. The project `Taskfile.yml` is **assembled**: this **core**
(cross-cutting tasks) plus each domain's own task block. **This file owns the codegen
pipeline + the cross-cutting tasks**; domain operational tasks live with their domain.

**Read when:** running stack commands, adding a task, or assembling a project's Taskfile.

## Contract
- The project Taskfile = **core** (here) + appended domain task blocks in **one file**:
  `tf:<component>:*` from `references/terraform.md`, `db-push` from `references/db.md`.
- `task generate` runs every code generator; `task typecheck` depends on it, so types
  always reflect fresh routes/actions/env/db.
- AWS-touching tasks gate on an identity check first.

## Non-negotiables
| key | rule | why |
| --- | --- | --- |
| assembled-one-file | the project Taskfile = this core + each scaffolded domain's task block, all in **one file**; task keys are literal (domains namespace by component, e.g. `tf:<component>:*`) | **do not** use go-task `includes:` — it splits into per-file Taskfiles and derives the namespace from the filename; one SSOT file with self-named keys keeps the command surface explicit and lets a dropped block take its exact tasks with it |
| domain-owns-ops | a domain's *operational* tasks live in its reference (`tf:<component>:*` → terraform.md, `db-push` → db.md), not here | dropping a domain takes its tasks with it; no cross-file drift |
| generate-pipeline | `generate` runs `generate-actions/-routes/-env/-db` (each guarded `if [ -f ]`); `typecheck` deps on `generate` | the engines import generated files; guards make trimming a subsystem a zero-edit no-op |
| no-jobs | there is no `generate-jobs` task | EventBridge is cut (SKILL.md) |
| aws-identity-gate | `check-aws-identity` + `login` live here; AWS/TF tasks `deps: [check-aws-identity]` | fail early with a clear message (AWS identity owned by `references/aws-oidc.md`) |
| prompt-on-destructive | destructive tasks are `interactive` with a `prompt:` (e.g. `db-push`, in db.md) | a human confirms before damage |
| alias-convention | tasks carry `desc` + both kebab and `colon:` aliases; helpers `internal: true` | discoverable via `task --list-all`, consistent surface |
| per-app-picker | `start` (`bunx --bun react-router dev`), `link` (`bunx vercel link`), `pull` (`bunx vercel env pull .env.vercel`) are dir-scoped per app (`start:<app>`/`link:<app>`/`pull:<app>`) from the **first** app in a monorepo — never deferred until a 2nd app appears; the bare `start`/`link`/`pull` are always interactive `select` pickers over whatever apps exist (`pull`'s picker also gets an `all` case) — Shape below | one namespacing style everywhere: domain first, app second, same as `tf:<component>:*`; shipping the picker shape from app #1 means adding app #2 is a pure addition, never a rename/refactor of tasks already in use |
| per-app-dotenv | in a monorepo, every dir-scoped per-app task (`start:<app>`, `link:<app>`, `pull:<app>`, `typecheck:<app>`, …) also carries its own `dotenv:` list, not just the root-level one; define it once as a YAML anchor on that app's first task (`dotenv: &<app>-dotenv [...]`) and reuse via `dotenv: *<app>-dotenv` on the rest — Shape below | go-task resolves a task-level `dotenv:` relative to that task's own `dir:` (confirmed in go-task source, not just its docs); the root-level `dotenv:` only ever sees root-level files, so `pull:<app>`'s own `.env.vercel` (written into that app's subdir) would silently never load into that app's tasks otherwise |
| one-offs-are-tasks | a throwaway/one-off script is **still** a `task` — never hand the user a bare `bun run …`/`terragrunt …`; add a dated `tmp-<slug>` block (script in gitignored `scripts/tmp/`), then delete block+script after it runs | one-offs need the same env/AWS/dotenv loading; quarantining + dating them stops scratch code rotting in the tree |

## Engine — copy faithfully (`assets/Taskfile.yml` → project root)
The **core** Taskfile. Then append the task blocks from the domain references you
scaffolded (terraform, db). The codegen generators stay here and are guarded, so you never
edit them when trimming a subsystem. Placement: SKILL.md.

## Shape — adding a task (illustration, not gospel)
```yaml
backfill:
  desc: Backfill X
  aliases: [back-fill]
  deps: [check-aws-identity]        # if it touches AWS
  interactive: true                 # + prompt: "…" if destructive
  cmds:
    - bun run scripts/backfill.ts {{.CLI_ARGS}}
```

`start`/`link`/`pull` in a monorepo (`per-app-picker` row) — one dir-scoped task per app
from app #1, bare task = picker. The first per-app task (`typecheck:web` here) defines
the `dotenv` anchor (`per-app-dotenv` row); every other `web` task reuses it via `*web-dotenv`:
```yaml
typecheck:web:
  desc: Type check the web app
  dir: web
  dotenv: &web-dotenv        # anchor once, per app — paths resolve relative to this dir:
    - .env
    - .env.vercel
  cmds:
    - bun run typecheck

start:web:
  desc: Start the web app dev server
  dir: web
  dotenv: *web-dotenv
  interactive: true
  cmds:
    - bunx --bun react-router dev

link:web:
  desc: Link the web app to its Vercel project
  dir: web
  dotenv: *web-dotenv
  interactive: true
  cmds:
    - bunx vercel link

pull:web:
  desc: Pull web app env vars from Vercel into .env.vercel
  dir: web
  dotenv: *web-dotenv
  interactive: true
  cmds:
    - bunx vercel env pull .env.vercel

start:   # no `all` case — dev servers run in the foreground, one at a time
  desc: Start an app's dev server (interactive app picker)
  interactive: true
  silent: true
  cmds:
    - |
      echo "Start which app?"
      select app in web api quit; do
        case "$app" in
          web) exec task start:web ;;
          api) exec task start:api ;;
          quit) break ;;
          *) echo "invalid" ;;
        esac
      done

link:   # pull: is identical, plus an `all` case → `exec task pull:web pull:api`
  desc: Link an app to its Vercel project (interactive app picker)
  interactive: true
  silent: true
  cmds:
    - |
      echo "Link which app?"
      select app in web api quit; do
        case "$app" in
          web) exec task link:web ;;
          api) exec task link:api ;;
          quit) break ;;
          *) echo "invalid" ;;
        esac
      done
```

## One-offs (temp tasks) — the convention
Agents reach for bare `bun run scratch.ts` / `terragrunt …` on throwaways because a full
task block feels heavy. It isn't optional: a one-off is **still** a task, just a *quarantined,
dated, short-lived* one. The `tmp-sweep` task + commented template ship in `assets/Taskfile.yml`.

**Recipe**
1. Script → `scripts/tmp/<slug>.ts`. Ensure `scripts/tmp/` is **gitignored** (one-offs are
   never committed) — add `scripts/tmp/` to `.gitignore` once.
2. Add a `tmp-<slug>` block, dated, with a `# added <date> — DELETE AFTER RUN` banner and a
   `desc: '[ONE-OFF <date>] … then remove this task + its script'`. `colon:` alias + `deps:
   [check-aws-identity]` if it touches AWS — same rules as any task.
3. Run it: `task tmp-<slug>` (args via `{{.CLI_ARGS}}` → `task tmp-<slug> -- --dry-run`).
4. **Clean up:** delete the block **and** the script. `task tmp-sweep` lists every lingering
   `tmp-*` block + `scripts/tmp/` file (read-only radar) so nothing rots — a non-empty sweep
   is a TODO, not a steady state.

Template (`tmp-backfill-foo`, a placeholder name — swap for the real slug): see the
commented block in `assets/Taskfile.yml`.

## Verify at latest
- **go-task v3** — confirm current schema for `requires`/`prompt`/`dir`/`dotenv`/aliases.

## Agent guardrails
The destructive/interactive tasks on this surface — `apply`, the dev server, `db-push`/
migrations — are governed by **SKILL.md → Global guardrails**. See there; not restated here.
