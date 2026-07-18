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
  description = "Only meaningful on the production stack — true once live/staging exists. The site has no manual secrets today, so this currently only affects the (empty) manual_secrets targeting; kept for convention parity with account-backend."
}

variable "vercel_project_id" {
  type        = string
  description = "The Vercel project id (prj_...) — created OUTSIDE Terraform (vercel link / dashboard), then wired in here. Placeholder until the project is created."
}

variable "vercel_project_name" {
  type        = string
  description = "The Vercel project's actual slug/name (as created in the dashboard/CLI) — MUST match exactly, since it's embedded in the OIDC trust condition (oidc.tf)."
}

variable "vercel_team_slug" {
  type = string
}

variable "paddle_client_token" {
  type        = string
  default     = ""
  description = "Paddle CLIENT-SIDE token for the /checkout page's Paddle.js (public by design — 'safe to expose in frontend code', NOT the API key). Per-stack (sandbox test_… vs live live_…), exposed to the app as PUBLIC_PADDLE_CLIENT_TOKEN. Always set — production carries a self-naming placeholder until the live token exists."
}

variable "turnstile_site_key" {
  type        = string
  default     = ""
  description = "Cloudflare Turnstile SITE key for the /contact form's widget — the public half of the pair (it is rendered into the page markup), so TF-managed alongside the Paddle client token rather than dashboard-set. Exposed to the app as PUBLIC_TURNSTILE_SITE_KEY. Empty = the contact form renders with no spam check, which the server logs loudly."
}

variable "manual_secrets" {
  type        = map(string)
  default     = {}
  description = "Vercel env vars declared here but whose value is set in the Vercel dashboard (value changes are ignored — see vercel-env-vars.tf). The site's two are CD2_API_KEY (the transactional-mail sender key) and TURNSTILE_SECRET_KEY (the secret half of the Turnstile pair), both used only by the /contact action."
}
