# Vercel API token: shared SSM Parameter Store SecureString (team constant — terraform.md).
data "aws_ssm_parameter" "vercel_token" {
  name = "/adpharm/vercel-api-token-benhonda"
}

provider "vercel" {
  api_token = data.aws_ssm_parameter.vercel_token.value
  team      = var.vercel_team_slug
}

locals {
  # TF-managed: infra outputs, always overwritten, never secret.
  tf_managed = {
    AWS_ROLE_ARN                = aws_iam_role.vercel.arn
    AWS_REGION                  = var.aws_region
    COGNITO_USER_POOL_ID        = var.cognito_user_pool_id
    COGNITO_USER_POOL_CLIENT_ID = var.cognito_user_pool_client_id
  }
  # Prod-only, no staging → cover every Vercel target so preview/dev deploys aren't starved
  # (terraform.md env-var-ownership: prod-only ⇒ ["production","preview","development"]).
  targets = ["production", "preview", "development"]
}

resource "vercel_project_environment_variable" "managed" {
  for_each   = local.tf_managed
  project_id = var.vercel_project_id
  key        = each.key
  value      = each.value
  sensitive  = false
  target     = local.targets
}

resource "vercel_project_environment_variable" "manual" {
  for_each   = var.manual_secrets
  project_id = var.vercel_project_id
  key        = each.key
  value      = each.value
  # Prod-only (no staging) ⇒ false per terraform.md — `vercel env pull` can't fetch sensitive
  # vars, and preview/development need these values too. Flagged to Ben in live/production.
  sensitive = false
  target    = local.targets

  lifecycle {
    ignore_changes = [value] # never clobber the human-set value in the Vercel dashboard
  }
}
