# Wire these into the daemon's launchd environment (the COLDSTORE_* / AWS_* vars the
# daemon reads — see coldstorage/Sources/coldstored/main.swift).

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

output "daemon_access_key_id" {
  value       = aws_iam_access_key.daemon.id
  description = "→ daemon AWS_ACCESS_KEY_ID (store in Keychain)"
}

output "daemon_secret_access_key" {
  value       = aws_iam_access_key.daemon.secret
  sensitive   = true
  description = "→ daemon AWS_SECRET_ACCESS_KEY. Fetch once: `terragrunt output -raw daemon_secret_access_key`, store in Keychain, then never again. Rotate by tainting aws_iam_access_key.daemon."
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

output "cognito_user_role_arn" {
  value       = aws_iam_role.user.arn
  description = "The per-user IAM role assumed via the Identity Pool (scoped to blobs/<sub>/*)."
}
