# Wire these into the daemon's launchd environment (the COLDSTORE_* vars the daemon reads — see
# coldstorage/Sources/coldstored/main.swift).
#
# There are deliberately NO credential outputs. `iam.tf` — a long-lived IAM user whose secret was
# exported through a handoff file into the macOS Keychain — was deleted 2026-07-27 with the AWS account
# migration. The daemon has authenticated as the signed-in USER via Cognito STS since 2026-07-14, and
# `coldstored` now refuses to start without an identity pool, so nothing consumed those creds any more:
# they were a standing all-access key sitting in Terraform state and a Keychain entry, for nothing.
# Recreating one in the new account would have carried that forward for no reason.

output "bucket_name" {
  value       = aws_s3_bucket.vault.id
  description = "→ daemon COLDSTORE_BUCKET"
}

output "bucket_arn" {
  value = aws_s3_bucket.vault.arn
}

output "aws_region" {
  value       = var.aws_region
  description = "→ daemon AWS_REGION"
}

# ── Multi-user identity (Cognito — see cognito.tf / PROD.md). These are NOT secrets (public client
#    config); they ship in the app + the daemon's per-user config so it can resolve temp STS creds. ──
output "cognito_user_pool_id" {
  value       = aws_cognito_user_pool.main.id
  description = "→ app/daemon: the User Pool to authenticate against."
}

output "cognito_user_pool_client_id" {
  value       = aws_cognito_user_pool_client.app.id
  description = "→ app: the desktop app client id (public, no secret)."
}

output "cognito_identity_pool_id" {
  value       = aws_cognito_identity_pool.main.id
  description = "→ daemon: identityPoolId for CognitoAWSCredentialIdentityResolver."
}

output "cognito_domain" {
  # Full managed-login host. The domain resource is count-gated on a federated IdP being enabled;
  # empty string when OAuth is off (the app treats that as "sign-in not configured").
  value       = local.oauth_enabled ? "${one(aws_cognito_user_pool_domain.main[*].domain)}.auth.${var.aws_region}.amazoncognito.com" : ""
  description = "→ app: the managed-login (hosted UI) host for /oauth2/authorize + /oauth2/token."
}

output "cognito_user_role_arn" {
  value       = aws_iam_role.user.arn
  description = "The per-user IAM role assumed via the Identity Pool (scoped to blobs/<sub>/*)."
}
