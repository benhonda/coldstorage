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
  default     = 7
  description = "Days after object CREATION before a blob tagged coldstorage-reap=true is expired. The daemon tags a blob only once every file in it has been deleted; this rule is the only thing that deletes, so a compromised client can queue a reclamation but never perform one. Most tagged blobs are already older than this, so the tag is effectively the trigger — the window exists so a tag written against a brand-new object is still undoable."
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
    # Dev (`task ui:mac:dev`): custom-scheme deep links can't reach an unpackaged Electron on macOS (the
    # running Electron.app's Info.plist has no `coldstorage` scheme — Electron docs are explicit), so
    # dev sign-in redirects to a throwaway 127.0.0.1 listener the app binds per sign-in. Cognito allows
    # plain http for localhost only; the port is fixed because Cognito exact-matches the URL.
    "http://localhost:53682/auth/callback",
  ]
  description = "Redirect URIs for the desktop app's hosted-UI OAuth (Google/Apple) flow: the packaged app's custom scheme + the dev-mode loopback. Only used when a federated IdP is enabled."
}
