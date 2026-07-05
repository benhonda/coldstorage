# Hono API on Vercel — the server/JSON archetype

A backend service: **Hono on Vercel (Node)** — event ingest, a sender/webhook, a cron
worker. Same foundation as an RR7 app (Drizzle + Postgres, fail-fast zod env, root
Taskfile, Vercel + AWS-via-OIDC) **minus everything UI**: no Vite, no generators, no `~/`
alias, no client/server split. It's all server, `src/`-based, plain TS that Vercel/Bun
compiles directly.

**Read when:** building or extending a Hono API — the app entry, routers, request
validation, header auth, or the `vercel.json` cron/function config. For the shared
foundation, follow the linked refs (env, db, aws-oidc, terraform, taskfile) with the
all-server deltas below.

## Contract
- One Hono app in `src/index.ts`, `export default app` — Vercel's Node runtime serves it
  natively (no `@hono/node-server`, no manual handler).
- Domains split into sub-routers (`src/routers/<domain>/` or `src/routes/<domain>.ts`),
  each a `new Hono()`, mounted with `app.route("/prefix", router)`.
- Every external input is validated **in the handler**; auth is a per-router header check.
- Cron is Vercel-scheduled (`vercel.json` `crons`, GET only) hitting a route guarded by a
  `Bearer ${CRON_SECRET}` header.

## Non-negotiables
| key | rule | why |
| --- | --- | --- |
| default-export-app | `src/index.ts` exports the `Hono` instance as default; Vercel serves it (Node) with no adapter/handler glue | one entry, zero boilerplate |
| sub-router-compose | one `new Hono()` per domain mounted via `app.route(prefix, router)`; handlers split into files, never one mega-file | local + explicit; dropping a router takes its routes with it |
| relative-src-imports | `src/`-based, relative `./x.js` imports (ESM `.js` suffix, `moduleResolution: "bundler"`); **no `~/` alias, no Vite, no `assets/` engines** | Vercel builds `src/` directly — the RR7 alias/codegen shell doesn't exist here |
| explicit-validation | validate every external input at the call site — `schema.parse(body)` (zod) for structured bodies, explicit guards otherwise; **not** `@hono/zod-validator` | validation is visible where it's used; malformed input fails loud |
| header-auth | auth is a per-router `.use()` middleware reading a header (`hono/basic-auth`, or an `X-API-Key`/`Bearer` check); stash caller identity with `c.set(...)` for handlers | server-to-server; no sessions, no OAuth redirects |
| cron-get-bearer | Vercel crons are **GET** routes listed in `vercel.json`, guarded by `Authorization: Bearer ${CRON_SECRET}` (Vercel sends it) | Vercel cron invokes GET; the secret gates public reachability |
| json-contract | responses are `c.json(...)`: success `{ … }` / `{ ok: true }`, error `{ error: string }` + status; use standard codes (401/403/404/409/422/500) | one predictable response shape |
| env-all-server | same fail-fast zod env as `references/env.md`, but a Hono API is **all-server** — one `src/lib/env.ts`, no `PUBLIC_`/client split, no env generator | nothing reaches a client; the RR7 split + codegen are moot |
| db-serverless | Drizzle over Postgres per `references/db.md`, Neon HTTP driver for serverless, instantiated once in `src/lib/db/`; a data-client app may use the **postgresdk SDK** instead (its own skill) — no schema-barrel generator unless the app adds one | serverless-safe connection; same DB foundation, server layout |
| aws-oidc-sso | AWS via the `references/aws-oidc.md` identity model — `awsCredentialsProvider({ roleArn: AWS_ROLE_ARN })` in prod, `fromSSO({ profile: "pharmer" })` in dev — one shared `awsCredentials` fed to every SES/SQS/S3 client | no stored keys; provisioning + env vars stay TF-owned (`references/terraform.md`) |

## Engine — none
A Hono API has **no bespoke engine** in `assets/` — it's all Shape at current best
practice on top of the shared foundation. Nothing to copy verbatim; write it fresh and
verify each library's current API.

## Shape — representative, not gospel
```ts
// src/index.ts
import { Hono } from "hono";
import { events } from "./routers/events/index.js";
const app = new Hono();
app.route("/v1/events", events);
export default app;                       // Vercel serves this directly

// src/routers/events/index.ts
import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import { env } from "../../lib/env.js";
export const events = new Hono();
events.use(basicAuth({ username: env.API_USER, password: env.API_PASS }));
events.post("/", async (c) => {
  const body = eventSchema.parse(await c.req.json());   // validate in-handler
  const row = await insertEvent(body);                  // thin handler → testable fn
  return c.json({ id: row.id }, 201);
});

// src/lib/aws-credentials.ts — one shared creds object (OIDC prod / SSO dev)
export const awsCredentials =
  process.env.NODE_ENV === "production"
    ? awsCredentialsProvider({ roleArn: env.AWS_ROLE_ARN })
    : fromSSO({ profile: "pharmer" });
```
The two live apps differ on the flexible bits — **project choices, not gospel**: raw
Drizzle (`event-store-api`) vs the postgresdk SDK (`sender-api`); a local zod `src/lib/env.ts`
vs a shared `getFromEnv()` helper; `vitest` vs `bun:test`; `zod.parse()` vs manual guards.
Keep handlers thin wrappers around testable functions and test the functions, not the HTTP.

## Tasks — append per-app blocks to the root Taskfile (core: `references/taskfile.md`)
An API in a monorepo namespaces domain-first, app-second (like `tf:<component>:*`):
`deploy:<app>` (`bunx vercel`), `link:<app>` / `pull:<app>` (Vercel link + env pull —
`per-app-picker` in taskfile.md), `typecheck:<app>`, `test:<app>`. Same convention +
guardrails as every other domain block — one file, self-named keys.

## Verify at latest
- **hono** — current routing, `hono/basic-auth`, and the built-in validator helpers.
- **@vercel/node** + Vercel's native Hono/ESM serving and `vercel.json` `functions`/`crons`
  schema (function `maxDuration`, GET-only cron paths).
- **@vercel/functions** `awsCredentialsProvider` (OIDC) — shared identity model with
  `references/aws-oidc.md`; **@neondatabase/serverless** driver — shared with `references/db.md`.
