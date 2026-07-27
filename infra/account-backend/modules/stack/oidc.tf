# Vercel → AWS via OIDC role assumption (no stored keys) — the adpharm-stack convention for
# every Vercel project. Dormant from 2026-07-01 (the service made no AWS calls) until
# 2026-07-13, when the retrieval hard gate (root RETRIEVAL.md) gave it exactly one job:
# holding `s3:RestoreObject`, the permission the USER's Cognito role deliberately lacks.
# The foresight paid off — the role already existed, so this needed no new trust plumbing.
#
# The OIDC provider is an account-level singleton (AWS allows one per issuer URL) that this repo READS
# and never owns — in Adpharm's account an old Adpharm project created it; in Ben's own account
# `vercel-log-drain` did, on 2026-07-19. Adopting it here would mean a `terragrunt destroy` of
# ColdStorage deletes the provider a sibling project authenticates with. See modules/shared/main.tf.
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
        # Pin the audience as well as the subject. The provider's own client_id_list already constrains
        # `aud`, so this is defence in depth — and it matters MORE here than usual, because that list
        # lives in a different project's Terraform entirely: someone could widen it without ever seeing
        # this file. Verified against the live provider 2026-07-27 (audience `https://vercel.com/benhonda`).
        StringEquals = {
          "oidc.vercel.com/${var.vercel_team_slug}:aud" = "https://vercel.com/${var.vercel_team_slug}"
        }
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

# ── The retrieval hard gate's other half ──────────────────────────────────────────────────────────
# The user's Cognito role has PutObject + GetObject on its own prefix but NOT s3:RestoreObject
# (infra/coldstorage/.../cognito.tf). Deep Archive objects are unreadable until thawed, so the thaw
# is the gate — and THIS role is the only principal that can perform it. The backend thaws a blob
# only for a restore job that is paid for (or covered by the free allowance).
#
# Least privilege, deliberately:
#   - RestoreObject : the gate itself.
#   - GetObject     : ONLY so HeadObject works (IAM has no separate HeadObject action) — the backend
#                     reads blob SIZES to price a thaw honestly. It never reads an object BODY, and
#                     could not decrypt one if it did: the MasterKey never leaves the user's device.
#                     Zero-knowledge is untouched by this grant.
#   - Scoped to blobs/* — the vault objects, nothing else in the bucket.
# No ListBucket: the backend is always told exactly which keys to act on, and verifies they belong to
# the caller (identity.server.ts) before touching them. It never needs to enumerate anyone's vault.
data "aws_iam_policy_document" "vercel_s3_thaw" {
  statement {
    sid    = "ThawAndSizeVaultBlobs"
    effect = "Allow"
    actions = [
      "s3:RestoreObject",
      "s3:GetObject",
    ]
    resources = ["${var.vault_bucket_arn}/blobs/*"]
  }
}

resource "aws_iam_role_policy" "vercel_s3_thaw" {
  name   = "${var.project_name}-${var.env}-vercel-s3-thaw"
  role   = aws_iam_role.vercel.id
  policy = data.aws_iam_policy_document.vercel_s3_thaw.json
}
