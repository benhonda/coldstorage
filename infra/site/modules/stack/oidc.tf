# Vercel → AWS via OIDC role assumption (no stored keys) — the adpharm-stack convention for
# every Vercel project, kept even though the marketing site makes NO AWS calls at runtime
# today. Free to have dormant; avoids a second infra change if the site later needs AWS
# (e.g. S3-hosted OG images, or R2 for the thumbnail view). Its ARN is an output only — NOT
# pushed as a Vercel env var (the app doesn't read it, and terraform.md's env-var-ownership
# says a deployed env var must exist in the app's zod schema).
#
# The AWS account already has an IAM OIDC provider for oidc.vercel.com/adpharm and the
# /adpharm/vercel-api-token-benhonda SSM param (set up by account-backend — see its oidc.tf).
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
          # var.vercel_project_name (NOT var.project_name) — Vercel's OIDC token `sub` claim
          # embeds the real Vercel project slug here; project_name is just this Terraform
          # component's label (state key, IAM role name).
          "oidc.vercel.com/${var.vercel_team_slug}:sub" = "owner:${var.vercel_team_slug}:project:${var.vercel_project_name}:environment:${var.env}"
        }
      }
    }]
  })
}
