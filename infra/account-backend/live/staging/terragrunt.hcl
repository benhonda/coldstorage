# Staging env stack — exists specifically for Paddle SANDBOX testing: a stable, deployed
# URL (Vercel custom environment, branch-tracked on `staging`) for the sandbox webhook to
# hit, plus its own DATABASE_URL so test events never touch real subscription data.
#
# Cognito is NOT duplicated here — infra/coldstorage has no staging tier (auth isn't the
# thing being sandboxed; Ben logs in with a real Cognito account either way). This stack
# reads the SAME production Cognito outputs as live/production/terragrunt.hcl.
terraform {
  source = "../../modules/stack"
}

include "root" {
  path = find_in_parent_folders("root.hcl")
}

dependency "coldstorage" {
  config_path = "../../../coldstorage/live/production"
  mock_outputs = {
    cognito_user_pool_id        = "mock_user_pool_id"
    cognito_user_pool_client_id = "mock_client_id"
  }
}

inputs = {
  env = "staging"

  # Same Vercel PROJECT as production — staging is a custom environment (branch-tracked)
  # within it, not a separate project (see modules/stack/vercel-env-vars.tf).
  vercel_project_id   = "prj_IhOlkinKj2zIuHQBBTJhdP7s008w"
  vercel_project_name = "coldstorage-account-backend"
  vercel_team_slug    = "adpharm"

  cognito_user_pool_id        = dependency.coldstorage.outputs.cognito_user_pool_id
  cognito_user_pool_client_id = dependency.coldstorage.outputs.cognito_user_pool_client_id

  # The Paddle SANDBOX recurring price the checkout sells (PROD.md Phase 5c): 500 GB, 1-year term,
  # from the seeded canonical catalog (`task backend:paddle:seed -- --env sandbox`, PADDLE.md).
  # Non-secret (it's exposed at checkout), so it lives here in TF, not the dashboard.
  paddle_price_id = "pri_01kx53mkb5knv7qgntq5w8jewc"

  # Paddle SANDBOX client-side token (dashboard → Developer tools → Authentication → client-side
  # tokens) for the GET /checkout default-payment-link page. Public by design ("safe to expose in
  # frontend code" — Paddle docs; it can only open checkouts / preview prices), so TF-managed like
  # the price id.
  paddle_client_token = "test_36ccedef6021b9f6c385bc5b643"

  # target=["preview","development"], scoped further to the `staging` custom environment —
  # must stay non-sensitive (Vercel can't pull sensitive vars for preview/dev). Set the REAL
  # sandbox values in the dashboard after apply: a Paddle SANDBOX API key + webhook secret
  # (from the Paddle sandbox account, not the live one), and a separate Neon
  # database/branch's connection string — not the production DATABASE_URL.
  manual_secrets = {
    DATABASE_URL          = "SET_IN_VERCEL_DASHBOARD"
    PADDLE_WEBHOOK_SECRET = "SET_IN_VERCEL_DASHBOARD"
    PADDLE_API_KEY        = "SET_IN_VERCEL_DASHBOARD"
  }
}
