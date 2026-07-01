# Vercel → AWS via OIDC role assumption (no stored keys) — the adpharm-stack convention for
# every Vercel project, kept even though this service currently makes no AWS calls at
# runtime (Cognito ID-token verification is a plain JWKS fetch, no AWS SDK/credentials
# needed). Free to have dormant; avoids a second infra change if/when this service does
# need AWS access (e.g. an admin Cognito lookup).
#
# PREREQUISITE (unverified — flag to Ben before the first plan): this data source expects
# an EXISTING AWS IAM OIDC provider for oidc.vercel.com/<team>. infra/coldstorage explicitly
# has none (it opted out of the Vercel convention entirely), so if no other Adpharm project
# in this AWS account has set one up yet, `terragrunt plan` will fail here — the provider
# would need to be created once (a resource, not a data source) before this stack can plan
# clean. Confirm which is true before assuming this data lookup succeeds.
data "aws_iam_openid_connect_provider" "vercel" {
  url = "https://oidc.vercel.com/${var.vercel_team_slug}"
}

resource "aws_iam_role" "vercel" {
  name = "${var.project_name}-${var.env}-vercel"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = data.aws_iam_openid_connect_provider.vercel.arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringLike = {
          "oidc.vercel.com/${var.vercel_team_slug}:sub" = "owner:${var.vercel_team_slug}:project:${var.project_name}:environment:${var.env}"
        }
      }
    }]
  })
}
