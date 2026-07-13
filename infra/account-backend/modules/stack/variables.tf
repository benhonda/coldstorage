variable "project_name" {
  type = string
}

variable "aws_profile" {
  type = string
}

variable "aws_region" {
  type = string
}

variable "env" {
  type        = string
  description = "production | staging"
}

variable "has_staging" {
  type        = bool
  default     = false
  description = "Only meaningful on the production stack — true once live/staging exists, so production's manual secrets go sensitive (target=[\"production\"] only) instead of also covering preview/development. Unused on the staging stack itself."
}

variable "vercel_project_id" {
  type        = string
  description = "The Vercel project id (prj_...) — created outside Terraform (vercel link / dashboard), then wired in here."
}

variable "vercel_project_name" {
  type        = string
  description = "The Vercel project's actual slug/name (as created in the dashboard/CLI) — MUST match exactly, since it's embedded in the OIDC trust condition (oidc.tf). Not necessarily the same string as project_name (this component's Terraform/state label)."
}

variable "vercel_team_slug" {
  type = string
}

variable "cognito_user_pool_id" {
  type        = string
  description = "From infra/coldstorage's Cognito output — the ID token issuer this service verifies against."
}

variable "cognito_user_pool_client_id" {
  type        = string
  description = "From infra/coldstorage's Cognito output — the desktop app's public client id (audience check)."
}

variable "manual_secrets" {
  type        = map(string)
  description = "Vercel env vars this Terraform config declares but does NOT own the value of (DATABASE_URL, Paddle keys) — set for real in the Vercel dashboard after first apply."
}

variable "paddle_client_token" {
  type        = string
  default     = ""
  description = "Paddle CLIENT-SIDE token (dashboard → Developer tools → Authentication) for the GET /checkout page's Paddle.js — the default-payment-link page the hosted checkout renders on. Public by design (Paddle: 'safe to expose in frontend code'), NOT the API key; per-stack (sandbox test_… vs live live_…). Empty ⇒ the env var isn't set (/checkout returns a clear 'set PADDLE_CLIENT_TOKEN' error until you fill this in)."
}

# ── Retrieval hard gate (2026-07-13, root RETRIEVAL.md) ────────────────────────────────────────────
# All three read from infra/coldstorage's outputs (SSOT — never hand-copied), same as the Cognito ids
# above. They exist because this service now performs the Deep Archive thaw that the user's own
# credentials deliberately cannot: it must know WHICH bucket, and WHO the caller really is in S3 terms.

variable "vault_bucket_arn" {
  type        = string
  description = "From infra/coldstorage's bucket_arn output — the vault the OIDC role may thaw blobs in (scoped to blobs/*)."
}

variable "vault_bucket_name" {
  type        = string
  description = "From infra/coldstorage's bucket_name output — the same bucket, as the backend's VAULT_BUCKET_NAME env var."
}

variable "cognito_identity_pool_id" {
  type        = string
  description = "From infra/coldstorage's cognito_identity_pool_id output. The backend trades a caller's verified ID token for their IDENTITY-pool id (Cognito GetId) — the id S3 keys are prefixed with (blobs/<identityId>/…) — so it can prove a blob belongs to the caller before thawing it at our expense. The User Pool sub (above) is a DIFFERENT identifier and cannot do this job."
}
