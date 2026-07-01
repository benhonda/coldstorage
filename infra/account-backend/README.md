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
  hand-copied; `PADDLE_ENVIRONMENT`) and manual secrets (`DATABASE_URL`, `PADDLE_WEBHOOK_SECRET`,
  `PADDLE_API_KEY` — Terraform declares the keys, values are set by hand in the Vercel dashboard).
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
TF-managed + manual env var; re-running `plan` shows "No changes" for both). The 3 manual
secrets per stack are still set to their Terraform-written placeholder
(`SET_IN_VERCEL_DASHBOARD`) unless Ben has since replaced them by hand in the Vercel
dashboard — that can't be verified from here (production's are `sensitive=true`, staging's
are technically readable via the Vercel API but not checked, to avoid pulling live secret
material into a doc/transcript). Remaining blockers are all manual, non-Terraform steps:
Neon DB(s), Paddle sandbox/live credentials, then setting those 6 real values — see
[`PROD.md`](../../PROD.md) Phase 4 for the exact checklist.
