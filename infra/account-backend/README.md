# `infra/account-backend` — the account-backend Vercel project

Terragrunt root for account-backend's Vercel-side infra. Follows the adpharm-stack
`terraform.md` conventions **as written** (container layout, centralized state, OIDC role,
TF-owned Vercel env vars, `~>` pins, verify-with-plan / never-apply) — unlike
`infra/coldstorage`, which deliberately opts out of the Vercel convention, this component
*is* the Vercel app, so it gets the full pattern.

> The Terraform/Terragrunt source here IS committed to this public repo. What's gitignored
> is state + secret-bearing artifacts (`.terraform/`, `.terragrunt-cache/`, `*.tfvars`) —
> see the root `.gitignore`'s "Terraform / Terragrunt" section, same as `infra/coldstorage`.

## What it provisions (production + staging)
- **Vercel project env vars** on `coldstorage-account-backend` (`prj_IhOlkinKj2zIuHQBBTJhdP7s008w`):
  TF-managed (`AWS_ROLE_ARN`, `AWS_REGION`, `COGNITO_USER_POOL_ID`, `COGNITO_USER_POOL_CLIENT_ID` —
  the last two read cross-component from `infra/coldstorage/live/production`'s outputs, not
  hand-copied; `PADDLE_ENVIRONMENT`; plus, when set per-stack, the non-secret `PADDLE_PRICE_ID` and
  `PADDLE_CLIENT_TOKEN` — see `modules/stack/variables.tf`) and manual secrets (`DATABASE_URL`,
  `PADDLE_WEBHOOK_SECRET`, `PADDLE_API_KEY` — Terraform declares the keys, values are set by hand in
  the Vercel dashboard; the API key needs Transactions read+write since 5c's `transactions.create`).
- **A Vercel custom environment** (`staging`, branch-tracked) — gives the sandbox-Paddle
  testing branch a stable URL, isolated env-var scope from production.
- **An OIDC IAM role** per env (`aws_iam_role.vercel`) — currently dormant (this service makes
  no AWS SDK calls at runtime; Cognito ID-token verification is a plain JWKS fetch), kept
  because it's the standing convention and costs nothing unused.

No custom domain yet (Vercel's default `*.vercel.app` domain is fine for v1 — YAGNI, same
call `infra/coldstorage` made for DNS).

## Use (all via the Taskfile — no raw commands)
```sh
task login                                    # AWS SSO (profile: pharmer)
task tf:plan  SERVICE=account-backend ENV=production   # or the picker: task tf:plan
task tf:apply SERVICE=account-backend ENV=production   # user runs this; never the agent
# then ENV=staging for the sandbox-Paddle stack
```
**Local dev secrets** (separate from the infra above — these give you real values on your
machine, not just provision the Vercel side):
```sh
task link                 # picker → account-backend: bunx vercel link (one-time per machine)
task pull                 # picker → account-backend: pulls staging's values into .env.vercel
```
`account-backend/.env` is an optional local override layered on top of `.env.vercel`
(`backend:dev`/`backend:db:push` load both via `bun --env-file`, `.env` wins on conflict).
Production's manual secrets are `sensitive=true` and **not** pullable by design — see
`modules/stack/vercel-env-vars.tf` and [`PROD.md`](../../PROD.md) Phase 4.

## Status
**Applied — both stacks live** (`terragrunt state list` confirms all 9 production / 10
staging resources exist for real: the OIDC role, the `staging` custom environment, and every
TF-managed + manual env var; re-running `plan` shows "No changes" for both). **All 6 manual
secrets are set for real** (staging's 3 on 2026-07-02; production's `DATABASE_URL` on
2026-07-01 and `PADDLE_API_KEY` + `PADDLE_WEBHOOK_SECRET` on 2026-07-10 — verified via env-var
`updatedAt` metadata, values never read). Both lanes are deployed and smoke-tested live at
`api.coldstorage.sh` / `api-staging.coldstorage.sh` — no remaining blockers. See
[`PROD.md`](../../PROD.md) Phase 4 for the full history and [`PADDLE.md`](../../PADDLE.md)
for the webhook destinations + runtime key scope.
