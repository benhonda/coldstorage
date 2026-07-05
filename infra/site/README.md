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

- **Vercel project:** created — `prj_QkTYTMBTzLCHXCsRncrrAThMSlv7`, wired into both live stacks.
  (Confirm the project slug is `coldstorage-site` — it's baked into the OIDC trust in `oidc.tf`.)
- **Plans:** both **clean** — `ENV=production` → 2 to add (OIDC role + `PUBLIC_PADDLE_ENVIRONMENT`);
  `ENV=staging` → 4 to add (OIDC role + the `staging` custom environment + both `PUBLIC_PADDLE_*`,
  scoped to it). Not yet applied.
- **DNS:** `coldstorage.sh` is managed **entirely in Vercel** (not TF/Route53) — nothing to do here.

## Deploy

`task tf:site:plan ENV=production` → review → `task tf:site:apply ENV=production`. Repeat with
`ENV=staging`. No manual dashboard secrets to set (the site has none). Then deploy the app itself
(git push to the linked project / `vercel deploy`).

## Related Ben-actions (see site/SPEC.md)

- Repoint Paddle's default-payment-link → `coldstorage.sh/checkout` (+ the staging URL).
- After the repoint, `account-backend/src/routes/checkout.ts` (the old brandless page) is redundant.
