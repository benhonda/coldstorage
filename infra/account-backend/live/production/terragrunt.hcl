# Production env stack — the Vercel project's env vars + OIDC role.
# Staging exists (live/staging/) so Paddle SANDBOX webhooks have a stable, deployed URL to
# hit and a database isolated from real subscription data — this is the "sandbox Paddle
# account" case, not a general-purpose dev environment (vercel dev + a local Neon branch
# still covers day-to-day local dev).
terraform {
  source = "../../modules/stack"
}

include "root" {
  path = find_in_parent_folders("root.hcl")
}

# Cross-component read of infra/coldstorage's Cognito outputs — SSOT (PILLAR3): the User
# Pool / app-client ids are already Terraform-managed there, so this stack just reads them
# instead of Ben hand-copying `terragrunt output` values into a Vercel env var.
dependency "coldstorage" {
  config_path = "../../../coldstorage/live/production"
  mock_outputs = {
    cognito_user_pool_id        = "mock_user_pool_id"
    cognito_user_pool_client_id = "mock_client_id"
  }
}

inputs = {
  env         = "production"
  has_staging = true # live/staging/ exists → these manual secrets go sensitive, see below

  # Verified 2026-07-01 via the Vercel API (GET /v9/projects/<id>): name is exactly
  # "coldstorage-account-backend", matching the OIDC trust condition below (oidc.tf).
  vercel_project_id   = "prj_IhOlkinKj2zIuHQBBTJhdP7s008w"
  vercel_project_name = "coldstorage-account-backend"
  vercel_team_slug    = "adpharm"

  cognito_user_pool_id        = dependency.coldstorage.outputs.cognito_user_pool_id
  cognito_user_pool_client_id = dependency.coldstorage.outputs.cognito_user_pool_client_id

  # The Paddle LIVE recurring price (PROD.md Phase 5c). Empty until the production Paddle catalog exists
  # (prod lane deferred) — set to the live pri_… when it does.
  paddle_price_id = ""

  # target=["production"] only, sensitive=true (has_staging=true above) per terraform.md's
  # env-var-ownership rule — these are REAL Paddle live-mode credentials + the real prod
  # Neon URL, never readable via `vercel env pull`. Set real values in the Vercel dashboard
  # after the first apply (these placeholders are intentionally not secrets themselves).
  manual_secrets = {
    DATABASE_URL          = "SET_IN_VERCEL_DASHBOARD"
    PADDLE_WEBHOOK_SECRET = "SET_IN_VERCEL_DASHBOARD"
    PADDLE_API_KEY        = "SET_IN_VERCEL_DASHBOARD"
  }
}
