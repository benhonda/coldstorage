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

## Worth knowing

- **The Vercel project slug is `coldstorage-web`**, which differs from `project_name`
  (`coldstorage-site`) — the latter is only this component's TF/state label and IAM role name. The slug
  is baked into the OIDC trust (`oidc.tf`), so they are not interchangeable.
- **DNS for `coldstorage.sh` lives entirely in Vercel**, never TF/Route53 — nothing here manages it.

## Deploy

`task tf:site:plan ENV=production` → review → `task tf:site:apply ENV=production`. Repeat with
`ENV=staging`. No manual dashboard secrets to set (the site has none). Then deploy the app itself
(git push to the linked project / `vercel deploy`).

## Related Ben-actions (see site/SPEC.md)

- Repoint Paddle's default-payment-link → `coldstorage.sh/checkout` (+ the staging URL).
- After the repoint, `account-backend/src/routes/checkout.ts` (the old brandless page) is redundant.
