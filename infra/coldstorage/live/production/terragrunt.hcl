# Production env stack — the S3 vault + the daemon IAM user.
# Staging later: `cp -r ../production ../staging`, set env = "staging". Nothing else changes
# (every resource name + the state path is keyed off env).
terraform {
  source = "../../modules/stack"
}

include "root" {
  path = find_in_parent_folders("root.hcl")
}

inputs = {
  env = "production"

  # Google sign-in (PROD.md: passwordless auth, 2026-07-02). Creds stored in SSM via
  # `task tf:coldstorage:google-creds` (2026-07-02).
  enable_google_idp = true

  # Serve managed login from a host we own, so Google's consent screen stops naming an AWS domain we
  # can never brand-verify (2026-08-10 — the full reasoning is in modules/stack/auth-domain.tf).
  auth_custom_domain = "auth.coldstorage.sh"
}
