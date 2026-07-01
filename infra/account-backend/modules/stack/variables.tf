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
