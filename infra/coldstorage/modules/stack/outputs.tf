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
  # ONE host, never two: the custom domain (auth.coldstorage.sh) once configured, the amazoncognito.com
  # prefix host otherwise, "" when OAuth is off (the app treats that as "sign-in not configured").
  # Both hosts stay live — see auth-domain.tf — but only this one is handed to clients, so there is
  # never a question of which is current. Computed in auth-domain.tf.
  value       = local.managed_login_host
  description = "→ app: the managed-login host for /oauth2/authorize + /oauth2/token."
}

# The one piece of this flow Terraform CANNOT own: Google's OAuth client lives in the Google Cloud
# console, so this URI has to be pasted into its authorized redirect URIs by hand. Surfaced as an
# output so the value is read out of the plan rather than reconstructed from memory (PILLAR5) — a typo
# here is a dead sign-in button with a redirect_uri_mismatch and no other symptom.
output "google_oauth_redirect_uri" {
  value       = local.managed_login_host == "" ? "" : "https://${local.managed_login_host}/oauth2/idpresponse"
  description = "→ Google Cloud console (manual): the OAuth client's authorized redirect URI."
}

output "cognito_user_role_arn" {
  value       = aws_iam_role.user.arn
  description = "The per-user IAM role assumed via the Identity Pool (scoped to blobs/<sub>/*)."
}
