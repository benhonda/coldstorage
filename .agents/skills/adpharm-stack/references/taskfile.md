# The Taskfile (core)

`task` is the command surface. The project `Taskfile.yml` is **assembled**: this **core** (cross-cutting tasks) plus each domain's own task block. **This file owns the codegen pipeline + the cross-cutting tasks**; domain operational tasks live with their domain.

**Read when:** running stack commands, adding a task, or assembling a project's Taskfile.

## Contract
- The project Taskfile = **core** (here) + appended domain task blocks in **one file**: `tf:<component>:*` from `references/terraform.md`, `db-push`/`reset-staging` from `references/db.md`.
- `task generate` runs every code generator; `task typecheck` depends on it, so types always reflect fresh routes/actions/env/db.
- AWS-touching tasks gate on an identity check first.

## Non-negotiables
| key | rule | why |
| --- | --- | --- |
| assembled-one-file | the project Taskfile = this core + each scaffolded domain's task block, all in **one file**; task keys are literal (domains namespace by component, e.g. `tf:<component>:*`) | **do not** use go-task `includes:` — it splits into per-file Taskfiles and derives the namespace from the filename; one SSOT file with self-named keys keeps the command surface explicit and lets a dropped block take its exact tasks with it |
| domain-owns-ops | a domain's *operational* tasks live in its reference (`tf:<component>:*` → terraform.md, `db-push`/`reset-staging` → db.md), not here | dropping a domain takes its tasks with it; no cross-file drift |
| generate-pipeline | `generate` runs `generate-actions/-routes/-env/-db` (each guarded `if [ -f ]`); `typecheck` deps on `generate` | the engines import generated files; guards make trimming a subsystem a zero-edit no-op |
| no-jobs | there is no `generate-jobs` task | EventBridge is cut (SKILL.md) |
| aws-identity-gate | `check-aws-identity` + `login` live here; AWS/TF tasks `deps: [check-aws-identity]`. The check resolves credentials through the SDK's `fromSSO()` (see the asset) — **never** `aws sts get-caller-identity` | fail early with a clear message (AWS identity owned by `references/aws-oidc.md`); `sts` answers from the CLI's own role-cred cache (`~/.aws/cli/cache`), which stays green until those creds hit their own expiry — the permission set's session duration, 1h by default, up to 12h — after the SSO token behind them is dead, so the gate reads ready while the app's `fromSSO()` and terraform are failing |
| test-task | a repo with any test file ships a `test` task (`bun test`, dir-scoped per app like the rest), and `typecheck` is not the whole definition of done — SKILL.md's guardrail names both | a test nothing runs is worse than no test: the contract reads as pinned while it silently rots. **Bun is more permissive than Node** — its `Response` accepts `statusText` Node rejects outright — so anything constructing a Web platform object (`Response`, `Headers`, `URL`) needs one check on Node, the runtime Vercel actually deploys to, before you trust a green suite (`copy-in-body-not-statustext` in `references/routing.md` is the bug this rule was written from) |
| prompt-on-destructive | destructive tasks are `interactive` with a `prompt:` (e.g. `db-push`, in db.md) | a human confirms before damage |
| alias-convention | tasks carry `desc` + both kebab and `colon:` aliases; helpers `internal: true` | discoverable via `task --list-all`, consistent surface |
| per-app-picker | `start` (`bunx react-router dev`), `link` (`bunx vercel link`), `pull` (`bunx vercel env pull .env.vercel` **plus** a `pull-secrets` step reading SSM into `.env.secrets` — sensitive Vercel vars never come down, see `env-vars-from-ssm` in `references/terraform.md`; list both files in `dotenv:`) are dir-scoped per app (`start:<app>`/`link:<app>`/`pull:<app>`) from the **first** app in a monorepo — never deferred until a 2nd app appears; the bare `start`/`link`/`pull` are always interactive `select` pickers over whatever apps exist (`pull`'s picker also gets an `all` case) — Shape below | one namespacing style everywhere: domain first, app second, same as `tf:<component>:*`; shipping the picker shape from app #1 means adding app #2 is a pure addition, never a rename/refactor of tasks already in use |
| secrets-prefix-var | the SSM prefix `pull-secrets:<app>` reads is a root-level `vars:` entry (`<APP>_SSM_PREFIX`), never inlined in the task and never read back out of `terragrunt output`; it points at the **staging** prefix wherever a staging env exists, production only on a prod-only project | the prefix is also a terragrunt input, so one declaration keeps them from drifting — same Taskfile-exported-SSOT shape as `AWS_PROFILE` (`aws-identity-gate`). Staging-by-default keeps live production credentials off developer laptops, which is most of why the secrets left Vercel in the first place |
| per-app-dotenv | in a monorepo, every dir-scoped per-app task (`start:<app>`, `link:<app>`, `pull:<app>`, `typecheck:<app>`, …) also carries its own `dotenv:` list, not just the root-level one; define it once as a YAML anchor on that app's first task (`dotenv: &<app>-dotenv [...]`) and reuse via `dotenv: *<app>-dotenv` on the rest — Shape below | go-task resolves a task-level `dotenv:` relative to that task's own `dir:` (confirmed in go-task source, not just its docs); the root-level `dotenv:` only ever sees root-level files, so `pull:<app>`'s own `.env.vercel` (written into that app's subdir) would silently never load into that app's tasks otherwise |
| requires-vs-dotenv-ordering | check a var sourced from a task-level `dotenv:` (an API key, etc.) with `preconditions:` (`sh: '[ -n "$VAR" ]'`, custom `msg:`) — never `requires: vars:` | go-task evaluates `requires` before that task's own `dotenv:` loads (confirmed against go-task v3.51.1); a dotenv-only var can never satisfy `requires`, so it fails closed on every single run — `preconditions:` run after dotenv and give a custom message besides |
| one-offs-are-tasks | a throwaway/one-off script is **still** a `task` — never hand the user a bare `bun run …`/`terragrunt …`; add a dated `tmp-<slug>` block (script in gitignored `scripts/tmp/`), then delete block+script after it runs | one-offs need the same env/AWS/dotenv loading; quarantining + dating them stops scratch code rotting in the tree |

## Engine — copy faithfully (`assets/Taskfile.yml` → project root)
The **core** Taskfile. Then append the task blocks from the domain references you scaffolded (terraform, db). The codegen generators stay here and are guarded, so you never edit them when trimming a subsystem. Placement: SKILL.md.

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

`start`/`link`/`pull` in a monorepo (`per-app-picker` row) — one dir-scoped task per app from app #1, bare task = picker. The first per-app task (`typecheck:web` here) defines the `dotenv` anchor (`per-app-dotenv` row); every other `web` task reuses it via `*web-dotenv`:
```yaml
vars:
  # One SSM prefix per app, declared once at the root (secrets-prefix-var row).
  # Point it at STAGING wherever staging exists — production credentials have no
  # business on a laptop; a prod-only project points at production because that's all there is.
  WEB_SSM_PREFIX: my-project-staging

typecheck:web:
  desc: Type check the web app
  dir: web
  dotenv: &web-dotenv        # anchor once, per app — paths resolve relative to this dir:
    - .env
    - .env.vercel
    - .env.secrets           # SSM-sourced secrets (per-app-picker) — gitignore it
  cmds:
    - bun run typecheck

test:web:
  desc: Run the web app's tests
  dir: web
  dotenv: *web-dotenv
  cmds:
    - bun test {{.CLI_ARGS}}

start:web:
  desc: Start the web app dev server
  dir: web
  dotenv: *web-dotenv
  interactive: true
  cmds:
    - bunx react-router dev

link:web:
  desc: Link the web app to its Vercel project
  dir: web
  dotenv: *web-dotenv
  interactive: true
  cmds:
    - bunx vercel link

pull:web:
  desc: Pull web app env vars — Vercel into .env.vercel, SSM secrets into .env.secrets
  dir: web
  dotenv: *web-dotenv
  interactive: true
  cmds:
    - bunx vercel env pull .env.vercel      # non-secrets (development target)
    - task: pull-secrets:web                # secrets — Vercel won't return them

pull-secrets:web:
  desc: Pull the web app's secrets from SSM into .env.secrets
  dir: web
  dotenv: *web-dotenv
  deps: [check-aws-identity]
  cmds:
    # pipefail + write-to-temp-then-mv: a bare `… > .env.secrets` truncates the file
    # BEFORE the pipeline runs and a failed `aws` still exits 0 through `jq`, so the
    # visible outcome of an expired session is an empty secrets file and a confusing
    # env error at boot. Fail loudly instead, leaving the previous pull intact.
    # `| @json` quotes and escapes the value — a secret containing a space, a
    # newline or a quote must survive the round trip into dotenv intact.
    - |
      set -o pipefail
      aws ssm get-parameters-by-path --path /{{.WEB_SSM_PREFIX}} --with-decryption --output json \
        | jq -r '.Parameters[] | ((.Name | split("/") | last | ascii_upcase | gsub("-"; "_")) + "=" + (.Value | @json))' \
        > .env.secrets.tmp
      [ -s .env.secrets.tmp ] || { echo "No parameters read from /{{.WEB_SSM_PREFIX}} — expired SSO session, or wrong prefix." >&2; exit 1; }
      mv .env.secrets.tmp .env.secrets

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
Agents reach for bare `bun run scratch.ts` / `terragrunt …` on throwaways because a full task block feels heavy. It isn't optional: a one-off is **still** a task, just a *quarantined, dated, short-lived* one. The `tmp-sweep` task + commented template ship in `assets/Taskfile.yml`.

**Recipe**
1. Script → `scripts/tmp/<slug>.ts`. Ensure `scripts/tmp/` is **gitignored** (one-offs are never committed) — add `scripts/tmp/` to `.gitignore` once.
2. Add a `tmp-<slug>` block, dated, with a `# added <date> — DELETE AFTER RUN` banner and a `desc: '[ONE-OFF <date>] … then remove this task + its script'`. `colon:` alias + `deps: [check-aws-identity]` if it touches AWS — same rules as any task.
3. Run it: `task tmp-<slug>` (args via `{{.CLI_ARGS}}` → `task tmp-<slug> -- --dry-run`).
4. **Clean up:** delete the block **and** the script. `task tmp-sweep` lists every lingering `tmp-*` block + `scripts/tmp/` file (read-only radar) so nothing rots — a non-empty sweep is a TODO, not a steady state.

Template (`tmp-backfill-foo`, a placeholder name — swap for the real slug): see the commented block in `assets/Taskfile.yml`.

## Verify at latest
- **go-task v3** — confirm current schema for `requires`/`prompt`/`dir`/`dotenv`/aliases.

## Agent guardrails
The destructive/interactive tasks on this surface — `apply`, the dev server, `db-push`/ migrations — are governed by **SKILL.md → Global guardrails**. See there; not restated here.
