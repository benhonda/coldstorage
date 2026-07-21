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

variable "reclaimable_blob_expiry_days" {
  type        = number
  default     = 180
  description = <<-EOT
    Days after object CREATION before a blob tagged coldstorage-reap=true is expired. Set to Deep Archive's
    180-day minimum ON PURPOSE, and the alignment does all the work:

    - A blob older than 180 days is already past the threshold, so tagging expires it on the next daily
      sweep — deleting genuinely-archived data returns the space within about a day.
    - A blob younger than that expires exactly when its minimum runs out — which is exactly when we stop
      being billed for it. A user cannot free space we are still paying for, so upload/delete churn can't
      cost us more than they pay. Deleting early would bill the full 180 days anyway; we'd gain nothing and
      hand out an abuse vector.

    Because quota is measured from a live S3 listing, this also means the user's usage falls at precisely
    the moment our cost does, with no separate accounting to keep in sync.
  EOT
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
  type = list(string)
  default = [
    # Packaged app: the custom scheme electron-builder registers in the app's Info.plist (Phase 5).
    "coldstorage://auth/callback",
    # Staging dogfood build (ui/identity.json): its own scheme so it installs alongside prod and its sign-in
    # callback routes to the staging install, not prod. Cognito is shared across lanes, so this must be an
    # allowed callback here for staging sign-in to work; additive, no effect on the prod app's flow.
    "coldstorage-staging://auth/callback",
    # Dev (`task ui:mac:dev`): custom-scheme deep links can't reach an unpackaged Electron on macOS (the
    # running Electron.app's Info.plist has no `coldstorage` scheme — Electron docs are explicit), so
    # dev sign-in redirects to a throwaway 127.0.0.1 listener the app binds per sign-in. Cognito allows
    # plain http for localhost only; the port is fixed because Cognito exact-matches the URL.
    "http://localhost:53682/auth/callback",
  ]
  description = "Redirect URIs for the desktop app's hosted-UI OAuth (Google/Apple) flow: the packaged app's custom scheme + the dev-mode loopback. Only used when a federated IdP is enabled."
}
