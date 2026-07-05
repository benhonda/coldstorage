# Production env stack — the marketing site's Vercel env vars + (dormant) OIDC role.
# Staging exists (live/staging/) as the Paddle SANDBOX /checkout target, so production's
# has_staging = true.
#
# Vercel project created 2026-07-05 (prj_QkTYTMBTzLCHXCsRncrrAThMSlv7). TF never creates the
# project (terraform.md) — it only wires its env vars + the (dormant) OIDC role. DNS for the
# apex `coldstorage.sh` is managed entirely IN VERCEL (not TF/Route53 — Ben's call 2026-07-05),
# so there is no DNS here and `modules/shared` stays empty.
terraform {
  source = "../../modules/stack"
}

include "root" {
  path = find_in_parent_folders("root.hcl")
}

inputs = {
  env         = "production"
  has_staging = true

  # vercel_project_name = the real Vercel slug (baked into the OIDC trust — oidc.tf). NOTE it
  # differs from project_name ("coldstorage-site", this component's TF/state label + IAM role name).
  vercel_project_id   = "prj_QkTYTMBTzLCHXCsRncrrAThMSlv7"
  vercel_project_name = "coldstorage-web"
  vercel_team_slug    = "adpharm"

  # 👉 Paste the Paddle LIVE client-side token (live_…) here once the live Paddle account
  # exists — that's the only change needed to turn on production checkout.
  paddle_client_token = "TODO_PASTE_LIVE_PADDLE_CLIENT_TOKEN_HERE"
}
