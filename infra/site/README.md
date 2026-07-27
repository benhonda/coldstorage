# infra/site — marketing website Vercel project

Terraform/Terragrunt for the ColdStorage **marketing site** (`site/`) Vercel project, following
the adpharm-stack `terraform.md` convention. Sibling to `infra/account-backend` (the API) and
`infra/coldstorage` (the Mac daemon + storage). This is the **simplest** of the three: no
Cognito, no database, no webhook secrets — its only app env vars are the two `PUBLIC_PADDLE_*`
values the `/checkout` page needs.

## What it manages

- **OIDC role** (`modules/stack/oidc.tf`) — Vercel→AWS role assumption, kept per convention but
  **dormant** (the marketing site makes no AWS calls today). ARN is an output only, not a Vercel
  env var.
- **Vercel env vars** (`modules/stack/vercel-env-vars.tf`), TF-owned, matching the app's zod
  schema:
  - `PUBLIC_PADDLE_ENVIRONMENT` — derived (`production` on prod, `sandbox` on staging).
  - `PUBLIC_PADDLE_CLIENT_TOKEN` — per-stack Paddle client token (public by design). Staging =
    the sandbox token; production = empty until the live Paddle catalog exists.
- **DNS** — **deferred** (`modules/shared/main.tf`), see below.

## Status (2026-07-05)
> **Migrated to Ben's own AWS account, 2026-07-27** ([`MIGRATION.md`](../../MIGRATION.md)). Applied and
> verified there; the old Adpharm stacks were destroyed the same day. Statuses below describe the
> CURRENT account.

- **Live** — the site is deployed + serving at `coldstorage.sh`, and both stacks are **applied** to
  real AWS/Vercel (Ben's own account since 2026-07-27).
- **Vercel project:** `prj_QkTYTMBTzLCHXCsRncrrAThMSlv7`, slug **`coldstorage-web`**. Note this differs
  from `project_name` (`coldstorage-site`), which is only this component's TF/state label + IAM role name.
- **Pending re-apply:** `vercel_project_name` was corrected `coldstorage-site` → `coldstorage-web` (it's
  baked into the OIDC trust — `oidc.tf`); it lands with the account migration's first apply in the new account (MIGRATION.md phase 2), so there is nothing separate to run.
- **Paddle:** staging carries the real sandbox client token; **production** carries the
  `TODO_PASTE_LIVE_PADDLE_CLIENT_TOKEN_HERE` placeholder until the live account exists. The default
  payment link has been **repointed to `coldstorage.sh/checkout`**.
- **DNS:** `coldstorage.sh` is managed **entirely in Vercel** (not TF/Route53) — nothing to do here.

## Deploy

`task tf:site:plan ENV=production` → review → `task tf:site:apply ENV=production`. Repeat with
`ENV=staging`. No manual dashboard secrets to set (the site has none). Then deploy the app itself
(git push to the linked project / `vercel deploy`).

## Related Ben-actions (see site/SPEC.md)

- Repoint Paddle's default-payment-link → `coldstorage.sh/checkout` (+ the staging URL).
- After the repoint, `account-backend/src/routes/checkout.ts` (the old brandless page) is redundant.
