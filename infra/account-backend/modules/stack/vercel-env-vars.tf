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

  # TF-managed: infra outputs + fully-determined-by-env values, always overwritten, never
  # secret. PADDLE_ENVIRONMENT is here (not a manual secret) because it's not external
  # secret material — it's fully determined by which stack this is.
  tf_managed = {
    AWS_ROLE_ARN                = aws_iam_role.vercel.arn
    AWS_REGION                  = var.aws_region
    COGNITO_USER_POOL_ID        = var.cognito_user_pool_id
    COGNITO_USER_POOL_CLIENT_ID = var.cognito_user_pool_client_id
    PADDLE_ENVIRONMENT          = local.is_prod ? "production" : "sandbox"
  }

  # terraform.md env-var-ownership: prod-only ⇒ all 3 targets (preview/dev need real values
  # too, since nothing else covers them); prod-with-staging ⇒ production only (staging owns
  # preview/development via its own custom environment); non-prod (staging) ⇒ preview+dev,
  # scoped further by custom_environment_ids below so it's THIS stack's staging values, not
  # some other branch's.
  targets = local.is_prod ? (var.has_staging ? ["production"] : ["production", "preview", "development"]) : ["preview", "development"]
}

# Only for non-production stacks — gives `staging` a STABLE URL (branch-tracked), unlike ad
# hoc preview deployments which get a new URL per push. Paddle's sandbox webhook needs one
# fixed destination to point at, not a moving target.
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
  sensitive              = false
  target                 = local.targets
  custom_environment_ids = local.is_prod ? null : [vercel_custom_environment.env[0].id]
}

resource "vercel_project_environment_variable" "manual" {
  for_each   = var.manual_secrets
  project_id = var.vercel_project_id
  key        = each.key
  value      = each.value
  # sensitive=true only once this is a prod-WITH-staging stack (target=["production"] only —
  # preview/development can't hold sensitive vars, `vercel env pull` can't fetch them). Real
  # production Paddle live keys + prod DATABASE_URL become non-pullable once staging exists.
  sensitive              = local.is_prod && var.has_staging
  target                 = local.targets
  custom_environment_ids = local.is_prod ? null : [vercel_custom_environment.env[0].id]

  lifecycle {
    ignore_changes = [value] # never clobber the human-set value in the Vercel dashboard
  }
}
