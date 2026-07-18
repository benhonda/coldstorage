# Staging env stack — the Paddle SANDBOX /checkout target: a stable, branch-tracked Vercel
# custom environment (on `staging`) so the sandbox default-payment-link has one fixed URL.
# Same Vercel PROJECT as production — staging is a custom environment within it, not a
# separate project (see modules/stack/vercel-env-vars.tf).
#
# Same Vercel project as production (prj_QkTYTMBTzLCHXCsRncrrAThMSlv7) — staging is a
# branch-tracked custom environment within it, not a separate project.
terraform {
  source = "../../modules/stack"
}

include "root" {
  path = find_in_parent_folders("root.hcl")
}

inputs = {
  env = "staging"

  vercel_project_id   = "prj_QkTYTMBTzLCHXCsRncrrAThMSlv7"
  vercel_project_name = "coldstorage-web"
  vercel_team_slug    = "adpharm"

  # Paddle SANDBOX client-side token (dashboard → Developer tools → Authentication → client-side
  # tokens) for the staging /checkout page — the SAME sandbox Paddle account account-backend's
  # staging uses. Public by design ("safe to expose in frontend code"), so TF-managed here.
  paddle_client_token = "test_36ccedef6021b9f6c385bc5b643"

  # Turnstile SITE key for staging's /contact form. Cloudflare's documented TESTING key —
  # "1x…AA" always passes, so the staging form exercises the real widget + the real siteverify
  # round trip without needing a domain-bound production widget. Pair it with the matching
  # always-passes SECRET in the dashboard: `1x0000000000000000000000000000000AA`. The two must
  # match — a production secret rejects dummy tokens and a test secret rejects real ones.
  turnstile_site_key = "1x00000000000000000000AA"

  manual_secrets = {
    CD2_API_KEY          = "SET_ME_in_vercel_dashboard"
    TURNSTILE_SECRET_KEY = "SET_ME_in_vercel_dashboard" # staging: 1x0000000000000000000000000000000AA
  }
}
