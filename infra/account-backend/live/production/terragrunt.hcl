# Production env stack — the Vercel project's env vars + OIDC role.
# No staging: this service is pre-launch/dogfood-only (Ben is user #1, same call ROADMAP.md
# made for infra/coldstorage) — `vercel dev` + a local Neon branch is the dev loop, matching
# how MinIO stands in for coldstorage's local dev. Add live/staging/ (copy this dir, env =
# "staging") if/when there's a real second environment to isolate.
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
  env = "production"

  # TODO(ben): fill in vercel_project_id once the Vercel project exists — `vercel link` (or
  # the dashboard) after a first `vercel deploy` from account-backend/, then `vercel project
  # ls` for the id. vercel_project_name MUST be created with exactly this name (it's the
  # OIDC trust condition's project slug, oidc.tf) — recommended so it reads clearly in a
  # multi-project team dashboard: coldstorage-<component>, matching this repo's directory.
  vercel_project_id   = "prj_TODO"
  vercel_project_name = "coldstorage-account-backend"
  vercel_team_slug    = "adpharm"

  cognito_user_pool_id        = dependency.coldstorage.outputs.cognito_user_pool_id
  cognito_user_pool_client_id = dependency.coldstorage.outputs.cognito_user_pool_client_id

  # Prod-only (no staging) → these target ["production","preview","development"] (Vercel's
  # "All Environments") and stay non-sensitive per terraform.md's env-var-ownership rule —
  # `vercel env pull` can't fetch sensitive vars, and prod-only must still feed preview/dev
  # deploys. Flag: their values are readable/pullable. Set real values in the Vercel
  # dashboard after the first apply (this placeholder is intentionally not a secret).
  manual_secrets = {
    DATABASE_URL          = "SET_IN_VERCEL_DASHBOARD"
    PADDLE_WEBHOOK_SECRET = "SET_IN_VERCEL_DASHBOARD"
    PADDLE_API_KEY        = "SET_IN_VERCEL_DASHBOARD"
  }
}
