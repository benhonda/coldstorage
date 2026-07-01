# Vercel → AWS via OIDC role assumption (no stored keys) — the adpharm-stack convention for
# every Vercel project, kept even though this service currently makes no AWS calls at
# runtime (Cognito ID-token verification is a plain JWKS fetch, no AWS SDK/credentials
# needed). Free to have dormant; avoids a second infra change if/when this service does
# need AWS access (e.g. an admin Cognito lookup).
#
# CONFIRMED (2026-07-01, via a real `terragrunt plan`): the AWS account already has an IAM
# OIDC provider for oidc.vercel.com/adpharm and the /adpharm/vercel-api-token-benhonda SSM
# param — some earlier Adpharm project set both up. infra/coldstorage has neither (it opted
# out of the Vercel convention entirely); this is the first component in THIS repo to use them.
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
          # var.vercel_project_name (NOT var.project_name) — this must be the Vercel
          # project's actual slug, since Vercel's OIDC token's `sub` claim embeds its real
          # project name here. project_name is just this Terraform component's label
          # (state key, IAM role name) and isn't guaranteed to match.
          "oidc.vercel.com/${var.vercel_team_slug}:sub" = "owner:${var.vercel_team_slug}:project:${var.vercel_project_name}:environment:${var.env}"
        }
      }
    }]
  })
}
