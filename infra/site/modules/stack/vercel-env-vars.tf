# Vercel API token: shared SSM Parameter Store SecureString (team constant — terraform.md).
data "aws_ssm_parameter" "vercel_token" {
  name = "/adpharm/vercel-api-token-benhonda"
}

provider "vercel" {
  api_token = data.aws_ssm_parameter.vercel_token.value
  team      = var.vercel_team_slug
}

locals {
  is_prod = var.env == "production"

  # TF-managed env vars — the marketing site's non-secret app config (matches the app's zod
  # schema). All three are PUBLIC_ (exposed to the browser via window.env) and non-secret by
  # design. PUBLIC_PADDLE_ENVIRONMENT is derived from the stack; PUBLIC_PADDLE_CLIENT_TOKEN is
  # always set per-stack — staging = the real sandbox token, production = a self-naming
  # placeholder until the live token exists (see live/production/terragrunt.hcl).
  # PUBLIC_TURNSTILE_SITE_KEY is the public half of the /contact form's Turnstile pair; its
  # secret half is a manual_secret below, because that one really is a secret.
  tf_managed = {
    PUBLIC_PADDLE_ENVIRONMENT  = local.is_prod ? "production" : "sandbox"
    PUBLIC_PADDLE_CLIENT_TOKEN = var.paddle_client_token
    PUBLIC_TURNSTILE_SITE_KEY  = var.turnstile_site_key
  }

  # terraform.md env-var-ownership targeting: prod-only ⇒ all 3 targets; prod-with-staging ⇒
  # production only; staging ⇒ preview+development, scoped to ITS custom environment below.
  targets = local.is_prod ? (var.has_staging ? ["production"] : ["production", "preview", "development"]) : ["preview", "development"]
}

# Only for non-production stacks — gives `staging` a STABLE, branch-tracked URL (unlike ad
# hoc preview deployments), so the Paddle SANDBOX default-payment-link can point at one fixed
# /checkout destination.
resource "vercel_custom_environment" "env" {
  count      = local.is_prod ? 0 : 1
  project_id = var.vercel_project_id
  name       = var.env
  branch_tracking = {
    pattern = var.env
    type    = "equals"
  }
}

resource "vercel_project_environment_variable" "managed" {
  for_each               = local.tf_managed
  project_id             = var.vercel_project_id
  key                    = each.key
  value                  = each.value
  sensitive              = false # both PUBLIC_ vars are public by design
  target                 = local.targets
  custom_environment_ids = local.is_prod ? null : [vercel_custom_environment.env[0].id]
}

# Declared here, valued in the Vercel dashboard. Two today, both for the /contact form:
# CD2_API_KEY (transactional-mail sender) and TURNSTILE_SECRET_KEY (Turnstile's secret half).
# The app treats both as OPTIONAL at boot, so a stack with the placeholders still deploys and
# serves — the contact form is the only thing that stops working, and it says so.
resource "vercel_project_environment_variable" "manual" {
  for_each               = var.manual_secrets
  project_id             = var.vercel_project_id
  key                    = each.key
  value                  = each.value
  sensitive              = local.is_prod && var.has_staging
  target                 = local.targets
  custom_environment_ids = local.is_prod ? null : [vercel_custom_environment.env[0].id]

  lifecycle {
    ignore_changes = [value] # never clobber the human-set value in the Vercel dashboard
  }
}
