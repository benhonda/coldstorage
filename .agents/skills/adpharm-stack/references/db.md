# Database — Drizzle + Postgres (Neon)

The data layer: a server-only Drizzle client, one schema file per domain, consolidated by a generator, with schema changes applied via `db:push` (no migrations).

**Read when:** adding/changing a table, querying the DB, or wiring the DB client.

## Contract
- A single server-only `db` client (Drizzle over the Neon HTTP serverless driver), connection string from validated env.
- Tables are defined one file per domain under `lib/db/schemas/`; a generator consolidates them into a barrel that `drizzle-kit` and the app import.
- Schema changes are pushed with `drizzle-kit push` — there are no migration files.

## Non-negotiables
| key | rule | why |
| --- | --- | --- |
| server-singleton | the client is `*.server.ts`, instantiated once, imported only in server code | one connection path; never reaches the client bundle |
| env-validated-url | `DATABASE_URL` comes from validated env | fail-fast config — owned by `references/env.md` |
| neon-default | default to Neon (the engine ships `neon-http`); don't make the Postgres host a scaffolding question | it's a one-file driver swap if the project is *explicitly* not on Neon — not a decision worth interrupting the user for |
| one-file-per-domain | one schema file per domain in `lib/db/schemas/` (`auth-schema.ts`, …) | the generator scans this; keeps schemas local |
| generated-barrel | `lib/db/schema.ts` is generated (`task generate`), never hand-edited | SSOT for the consolidated schema |
| timestamps-helper | reuse the shared `timestamps` helper for `created_at`/`updated_at` | DRY across tables |
| push-not-migrations | apply schema with `task db:push` (drizzle-kit push); no migration files, no rollback | intentional simplicity for this stack |
| push-needs-permission | permission required before `db:push`/migrations — **global guardrail, owned by SKILL.md**; locally `db:push` prompts to confirm `DATABASE_URL` | the prohibition lives once (SKILL.md); this row adds only the db-local confirm mechanism |
| staging-reset-conditional | only wire the post-push "reset staging from prod" offer (and the `reset-staging` task) when staging can be safely fully overwritten by prod; skip it if staging holds its own secrets — e.g. distinct auth/session or encryption keys — that a prod copy would clobber | a blanket prod→staging reset silently destroys secrets prod and staging must not share |
| staging-reset-needs-permission | same permission rule as `db-push` — **global guardrail, owned by SKILL.md**; locally `reset-staging` is `interactive` with its own `prompt:` | human confirms before a destructive overwrite |
| staging-reset-id-resolution | the only Neon identifier hardcoded as a Taskfile `var:` is `NEON_PROJECT_ID`; `reset-staging` resolves production/staging **branch** IDs itself at run time via Neon's list-branches API (production = `default: true`, staging = named `staging`) and aborts if it can't resolve two distinct IDs | branch IDs are Neon-assigned and drift if a branch is ever recreated; resolving by role/name at run time (Neon as SSOT) means the Taskfile can never silently point at a stale or wrong branch |
| monorepo-namespacing | `db-push:<app>` always namespaces per app past a 2nd app (safe — targets one database); `reset-staging` only namespaces per app when apps have isolated Neon projects — when they share one project/branch, ship a single task named for the shared resource instead (Monorepo section below) | one fan-out idiom for `db-push` (DRY, safe regardless of topology); `reset-staging`'s blast radius is the branch, not the app, so its naming must match Neon's actual topology or it lies to whoever runs it |

## Engine — copy faithfully
`assets/lib/db/{index.server.ts, schema-utils.ts, schema.generate.ts}`, `assets/lib/env/db-env.server.ts` (validated `DATABASE_URL` the client imports — satisfies `env-validated-url`), and `assets/drizzle.config.ts` (→ project root). `assets/lib/db/schemas/auth-schema.ts` ships as a worked example of the table convention — adapt it. `task generate` produces `app/lib/db/schema.ts`. Placement + deps: SKILL.md; pipeline: `references/taskfile.md`.

## Shape — write fresh per table (illustration, not gospel)
```ts
// lib/db/schemas/billing-schema.ts
import { pgTable, uuid, text } from "drizzle-orm/pg-core";
import { timestamps } from "~/lib/db/schema-utils";
export const invoicesTable = pgTable("invoices", {
  ...timestamps,
  id: uuid().defaultRandom().primaryKey(),
  status: text({ enum: ["draft", "paid"] }).notNull(),
});
// query in a server handler
import { db } from "~/lib/db/index.server";
const rows = await db.select().from(invoicesTable);
```

## Tasks — append to the project Taskfile (core lives in `references/taskfile.md`)
The schema-barrel generator runs via the core `task generate` pipeline (`generate-db`). The db-specific operational tasks — interactive + prompted, never silent. Single-app default below; monorepo (2+ apps) forks to per-app namespacing further down.
```yaml
db-push:
  desc: Push the Drizzle schema to the DB (drizzle-kit push) — NO migration files
  aliases: [push, db:push, drizzle-push]
  interactive: true
  prompt: "Before pushing schema changes, double-check DATABASE_URL — is it correct?"
  cmds:
    - bunx drizzle-kit push
    # Only add this offer if staging-reset-conditional (above) holds for this project —
    # otherwise leave db-push as just the push.
    - |
      echo ""
      printf "Schema pushed. Also reset the staging DB now? ⚠️  This COMPLETELY OVERWRITES staging with production data. [y/N] "
      read -r REPLY
      case "$REPLY" in
        # --yes skips reset-staging's own prompt — this question already served as the confirmation
        [yY]*) task --yes reset-staging ;;
        *) echo "Skipping staging reset." ;;
      esac
```
Companion task, same conditions — Neon-only. The only Neon identifier hardcoded as a Taskfile `var:` is `NEON_PROJECT_ID` (Neon console: Settings → General, or `neonctl projects list`); `reset-staging` resolves the production/staging **branch** IDs itself at run time from Neon's list-branches API (production = the `default: true` branch, staging = the branch named `staging`) and aborts before restoring if it can't resolve two distinct IDs. Needs `NEON_API_KEY` in `.env` and `jq`, both precondition-checked — **not** `requires:` (dotenv-vs-`requires` ordering, `references/taskfile.md`):
```yaml
reset-staging:
  desc: "HUMANS ONLY — reset the staging Neon branch to production state"
  interactive: true
  prompt: "⚠️  This COMPLETELY OVERWRITES the staging DB with production data. Continue?"
  preconditions:
    - sh: '[ -n "$NEON_API_KEY" ]'
      msg: "NEON_API_KEY is not set — add it to .env"
    - sh: 'command -v jq >/dev/null 2>&1'
      msg: "jq is required to resolve Neon branch IDs from the API — please install jq"
  vars:
    NEON_PROJECT_ID: "<neon project id>"   # the ONE Neon identifier we hardcode
  cmds:
    - |
      echo "🔍 Resolving Neon branch IDs from project {{.NEON_PROJECT_ID}} (Neon is the SSOT)..."
      BRANCHES="$(curl -sS --fail-with-body \
        "https://console.neon.tech/api/v2/projects/{{.NEON_PROJECT_ID}}/branches" \
        -H "Authorization: Bearer ${NEON_API_KEY}" \
        -H "Accept: application/json")"
      PROD_ID="$(printf '%s' "$BRANCHES" | jq -r '[.branches[] | select(.default == true)] | .[0].id // empty')"
      STAGING_ID="$(printf '%s' "$BRANCHES" | jq -r '[.branches[] | select(.name == "staging")] | .[0].id // empty')"
      if [ -z "$PROD_ID" ] || [ -z "$STAGING_ID" ] || [ "$PROD_ID" = "$STAGING_ID" ]; then
        echo "✖ Could not resolve distinct branch IDs (production='${PROD_ID:-∅}', staging='${STAGING_ID:-∅}'). Aborting — no restore performed." >&2
        exit 1
      fi
      echo "   production → ${PROD_ID}"
      echo "   staging    → ${STAGING_ID}  (this is the branch being overwritten)"
      # preserve_under_name is required because staging has child branches (e.g. dev
      # branches parented off it) — Neon re-parents them onto the backup branch.
      # Old staging-pre-reset-* backups can be deleted in the Neon console.
      BACKUP_NAME="staging-pre-reset-$(date +%Y%m%d-%H%M%S)"
      echo "🔄 Restoring staging from production (current state → ${BACKUP_NAME})..."
      curl -sS --fail-with-body -X POST \
        "https://console.neon.tech/api/v2/projects/{{.NEON_PROJECT_ID}}/branches/${STAGING_ID}/restore" \
        -H "Authorization: Bearer ${NEON_API_KEY}" \
        -H "Content-Type: application/json" \
        -d "{\"source_branch_id\": \"${PROD_ID}\", \"preserve_under_name\": \"${BACKUP_NAME}\"}"
      echo ""
      echo "🎉 Staging reset complete! Previous staging state kept as '${BACKUP_NAME}'."
```

### Monorepo (2+ apps) — `db-push:<app>` namespaces freely; `reset-staging` depends on Neon topology
`db-push:<app>` forks exactly like `tf:<component>:*`/`per-app-picker` — dir-scoped, same body as the flat task above, reusing that app's `dotenv:` anchor (`per-app-dotenv` in taskfile.md) — safe regardless of topology, because a push only ever targets one database. `reset-staging` resets a whole Neon **branch**, so check the topology before forking it:
- **Each app has its own isolated Neon project:** fork `reset-staging:<app>` exactly like `db-push:<app>` — same body as the flat `reset-staging` above, each with its own `NEON_PROJECT_ID`.
- **Apps share one Neon project (the common shape — one branch, one database per app):** do **not** namespace per app — ship a single task named for the shared resource instead (e.g. `reset-staging:<product>`, never `reset-staging:web`), same ID-resolution body as the flat `reset-staging` above, but with its `desc:`/`prompt:` enumerating every app DB it wipes (plus any co-located resource riding the same reset, e.g. an S3 sync). A name like `reset-staging:web` promises an isolation the infra doesn't have — running it would silently also wipe every other app's staging data on that shared branch.
```yaml
db-push:web:                    # dir-scoped, same body as db-push above
  desc: Push the web app's Drizzle schema to the DB (drizzle-kit push) — NO migration files
  dir: web
  dotenv: *web-dotenv
  interactive: true
  prompt: "Before pushing schema changes, double-check DATABASE_URL — is it correct?"
  cmds:
    - bunx drizzle-kit push
    - |
      echo ""
      printf "Schema pushed. Also reset the staging DB now? ⚠️  This COMPLETELY OVERWRITES staging with production data. [y/N] "
      read -r REPLY
      case "$REPLY" in
        [yY]*) task --yes reset-staging ;;   # or reset-staging:web / reset-staging:<product> — match whichever fork applies
        *) echo "Skipping staging reset." ;;
      esac

# repeat db-push:<app> per app, then add its bare entry-point picker:
db-push:
  desc: Push a Drizzle schema (interactive app picker)
  aliases: [push, db:push, drizzle-push]
  interactive: true
  silent: true
  cmds:
    - |
      echo "Push schema for which app?"
      select app in web quit; do
        case "$app" in
          web) exec task db-push:web ;;
          quit) break ;;
          *) echo "invalid" ;;
        esac
      done
```
Isolated-project case: `reset-staging:<app>` gets the same `select`-dispatch picker as `db-push` above. Shared-project case: there's just the one `reset-staging:<product>` task — no picker, nothing to pick between.

## Verify at latest
- **drizzle-orm** + **drizzle-kit** — current `pg-core` builders and `defineConfig`.
- **@neondatabase/serverless** + `drizzle-orm/neon-http` — confirm the current Neon adapter wiring (if the app isn't on Neon, swap to the current driver for its Postgres host while keeping the server-singleton + env-validated contract).
