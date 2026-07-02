# Per-environment stack inputs. EVERYTHING here is keyed off `var.env` so adding a
# staging env later is `cp -r live/production live/staging` + flip `env` — no module edits.

variable "project_name" {
  type        = string
  description = "Component name (from root inputs). Used in resource names."
}

variable "aws_region" {
  type        = string
  description = "AWS region for the bucket + IAM (from root inputs)."
}

variable "env" {
  type        = string
  description = "Environment name — drives every resource name + the state path."
  validation {
    condition     = contains(["production", "staging"], var.env)
    error_message = "env must be production or staging."
  }
}

variable "abort_incomplete_multipart_days" {
  type        = number
  default     = 7
  description = "Server-side cleanup of orphaned multipart parts (the daemon reuses uploadIds across crashes, but never-completed uploads are garbage). Days after initiation."
}

# ── Multi-user identity (Cognito — see cognito.tf / PROD.md). Auth is PASSWORDLESS (2026-07-02):
#    Google is the primary login, native email-OTP the fallback. Both IdPs are opt-in gates: they need
#    external creds (Ben provides), so they default off to keep the plan clean until the creds exist. ──
variable "enable_google_idp" {
  type        = bool
  default     = false
  description = "Wire Google as a Cognito IdP (also creates the hosted-UI domain + OAuth client config). Reads the OAuth client id/secret from SSM — store them first with `task tf:coldstorage:google-creds`. Email-OTP works without it."
}

variable "enable_apple_idp" {
  type        = bool
  default     = false
  description = "Wire Sign in with Apple as a Cognito IdP (also creates the hosted-UI domain + OAuth client config). Requires the apple_* vars below. Email-OTP works without it."
}

variable "apple_services_id" {
  type        = string
  default     = ""
  description = "Apple 'Services ID' (the Sign in with Apple client_id). Only used when enable_apple_idp=true."
}

variable "apple_team_id" {
  type        = string
  default     = ""
  description = "Apple Developer Team ID. Only used when enable_apple_idp=true."
}

variable "apple_key_id" {
  type        = string
  default     = ""
  description = "Key ID of the Apple Sign-in private key (.p8). Only used when enable_apple_idp=true."
}

variable "apple_private_key" {
  type        = string
  default     = ""
  sensitive   = true
  description = "Contents of the Apple Sign-in .p8 private key. Only used when enable_apple_idp=true. Pass via TF_VAR_apple_private_key, never commit."
}

variable "app_oauth_callback_urls" {
  type        = list(string)
  default     = ["coldstorage://auth/callback"]
  description = "Redirect URIs for the desktop app's hosted-UI OAuth (Google/Apple) flow. A custom scheme the Electron app registers. Only used when a federated IdP is enabled."
}
