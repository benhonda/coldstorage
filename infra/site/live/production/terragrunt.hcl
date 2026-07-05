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

  # vercel_project_name MUST match the real Vercel slug exactly (it's baked into the OIDC
  # trust — oidc.tf). Confirm the project's slug is "coldstorage-site" (adjust if it differs).
  vercel_project_id   = "prj_QkTYTMBTzLCHXCsRncrrAThMSlv7"
  vercel_project_name = "coldstorage-site"
  vercel_team_slug    = "adpharm"

  # Paddle LIVE client-side token for the /checkout default-payment-link page (public by
  # design, like account-backend's). Empty until the live Paddle account/catalog exists (prod
  # Paddle lane deferred) — set to the live_… token then. Empty ⇒ PUBLIC_PADDLE_CLIENT_TOKEN
  # is not set and /checkout shows its 'not set up yet' state.
  paddle_client_token = ""
}
