# Multi-user identity (the "go to prod" layer — see /workspace/PROD.md).
#
# Single-operator dogfooding uses the long-lived daemon IAM user in iam.tf. REAL downloaded users instead
# authenticate via Cognito and get SHORT-LIVED, per-user-scoped STS credentials — no shared key ever leaves
# our control, and user A's creds physically cannot touch user B's objects.
#
#   User Pool      = authentication — PASSWORDLESS (decided 2026-07-02): Google IdP + native email-OTP
#                    codes. NO user/password auth anywhere in the product. Issues an ID token.
#   Identity Pool  = authorization: exchanges that ID token for temporary STS creds via
#                    AssumeRoleWithWebIdentity, assuming `aws_iam_role.user` below.
#   user role      = S3 scoped to blobs/${cognito-identity.amazonaws.com:sub}/* — the per-user boundary.
#
# The daemon picks these up with aws-sdk-swift's CognitoAWSCredentialIdentityResolver (the 3 S3Client
# sites swap from the default chain to this resolver — Phase 2). Verified vs aws-sdk-swift + Cognito IAM
# docs 2026-06-29. CognitoAuth.swift consumes a ready ID token — it never authenticates itself, so the
# sign-in method is invisible to the daemon.
#
# NOTE on zero-knowledge: Cognito is AUTH ONLY. Regaining ACCOUNT access (new email code, Google account
# recovery) NEVER yields the encryption key — with passwordless auth the MasterKey is wrapped solely
# under the recovery code (PROD.md; the KEK_pw leg is retired). Auth ≠ key recovery, by design.

# ── User Pool: passwordless (email-OTP first factor; Google federation below) ─────────────────────────
resource "aws_cognito_user_pool" "main" {
  name                     = "${var.project_name}-${var.env}"
  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]

  # Native email-OTP passwordless needs the Essentials feature plan (Lite lacks choice-based auth;
  # first 10k MAU free, then ~$0.015/MAU — verified 2026-07-02).
  user_pool_tier = "ESSENTIALS"

  # Product decision: NO passwords in the app, ever — but AWS REQUIRES "PASSWORD" in this list
  # (UpdateUserPool rejects EMAIL_OTP-only with "Password should be configured as one of the allowed
  # first auth factors"; learned on apply 2026-07-02, the API reference doesn't document it). The
  # passwordless guarantee is enforced one level up: the app client never initiates a password flow
  # (no SRP/USER_PASSWORD in explicit_auth_flows) and OTP-signed-up users never HAVE a password, so
  # the factor is allowed-but-unusable. Passkeys/WEB_AUTHN wait until there's a reason.
  sign_in_policy {
    allowed_first_auth_factors = ["PASSWORD", "EMAIL_OTP"]
  }

  # Email-based account recovery (account access only — see the zero-knowledge note above). Inert while
  # no user has a password, but harmless and required-shaped if an admin ever sets one.
  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }
}

# Optional Sign in with Apple. Off by default (plan stays clean without Apple Developer creds). Flip
# enable_apple_idp=true and supply the apple_* vars (Ben, from the Apple Developer account) to wire it.
resource "aws_cognito_identity_provider" "apple" {
  count = var.enable_apple_idp ? 1 : 0

  user_pool_id  = aws_cognito_user_pool.main.id
  provider_name = "SignInWithApple"
  provider_type = "SignInWithApple"

  provider_details = {
    client_id        = var.apple_services_id
    team_id          = var.apple_team_id
    key_id           = var.apple_key_id
    private_key      = var.apple_private_key
    authorize_scopes = "email name"
  }

  attribute_mapping = {
    email = "email"
  }
}

# Optional Google sign-in — the PRIMARY login (decided 2026-07-02). Same gating pattern as Apple:
# off by default so the plan stays clean until the OAuth client exists. The creds live in SSM
# (`task tf:coldstorage:google-creds` stores them once — same pattern as account-backend's Vercel
# API token; no TF_VAR shell exports); flip enable_google_idp=true to read + wire them.
data "aws_ssm_parameter" "google_client_id" {
  count = var.enable_google_idp ? 1 : 0
  name  = "/coldstorage/google-oauth-client-id"
}

data "aws_ssm_parameter" "google_client_secret" {
  count = var.enable_google_idp ? 1 : 0
  name  = "/coldstorage/google-oauth-client-secret"
}

resource "aws_cognito_identity_provider" "google" {
  count = var.enable_google_idp ? 1 : 0

  user_pool_id  = aws_cognito_user_pool.main.id
  provider_name = "Google"
  provider_type = "Google"

  provider_details = {
    client_id        = data.aws_ssm_parameter.google_client_id[0].value
    client_secret    = data.aws_ssm_parameter.google_client_secret[0].value
    authorize_scopes = "email"
    # AWS computes + backfills these six for provider_type=Google after the first apply; without them
    # in config every later plan wants to strip them (perpetual harmless drift — surfaced 2026-07-02
    # by the Phase 5 callback-URL plan). Pinning the values AWS itself wrote keeps plans surgical.
    attributes_url                = "https://people.googleapis.com/v1/people/me?personFields="
    attributes_url_add_attributes = "true"
    authorize_url                 = "https://accounts.google.com/o/oauth2/v2/auth"
    oidc_issuer                   = "https://accounts.google.com"
    token_request_method          = "POST"
    token_url                     = "https://www.googleapis.com/oauth2/v4/token"
  }

  attribute_mapping = {
    email    = "email"
    username = "sub"
  }
}

locals {
  # Any federated IdP needs the hosted-UI (managed login) domain + OAuth client config; email-OTP via
  # the API needs neither.
  oauth_enabled = var.enable_apple_idp || var.enable_google_idp
}

# Hosted-UI domain — only needed for federated (OAuth) sign-in; gated with it.
resource "aws_cognito_user_pool_domain" "main" {
  count = local.oauth_enabled ? 1 : 0

  domain       = "${var.project_name}-${var.env}-${data.aws_caller_identity.current.account_id}"
  user_pool_id = aws_cognito_user_pool.main.id
}

# ── App client: the desktop app. Public client (no secret — a desktop app can't keep one). Choice-based
#    USER_AUTH for email-OTP; hosted-UI OAuth only when a federated IdP is enabled. No password/SRP
#    flows — passwordless by product decision (2026-07-02). ────────────────────────────────────────────
resource "aws_cognito_user_pool_client" "app" {
  name            = "${var.project_name}-${var.env}-desktop"
  user_pool_id    = aws_cognito_user_pool.main.id
  generate_secret = false

  explicit_auth_flows = [
    "ALLOW_USER_AUTH", # choice-based sign-in — carries the EMAIL_OTP first factor
    "ALLOW_REFRESH_TOKEN_AUTH",
  ]

  supported_identity_providers = compact([
    "COGNITO",
    var.enable_apple_idp ? "SignInWithApple" : "",
    var.enable_google_idp ? "Google" : "",
  ])

  # OAuth/hosted-UI is required for federated IdPs; for email-OTP (API) it's unused. Gated so the
  # default deployment doesn't carry dangling callback config.
  allowed_oauth_flows_user_pool_client = local.oauth_enabled
  allowed_oauth_flows                  = local.oauth_enabled ? ["code"] : []
  allowed_oauth_scopes                 = local.oauth_enabled ? ["email", "openid", "profile"] : []
  callback_urls                        = local.oauth_enabled ? var.app_oauth_callback_urls : []
  logout_urls                          = local.oauth_enabled ? var.app_oauth_callback_urls : []

  token_validity_units {
    access_token  = "hours"
    id_token      = "hours"
    refresh_token = "days"
  }
  access_token_validity  = 1
  id_token_validity      = 1
  refresh_token_validity = 30

  depends_on = [aws_cognito_identity_provider.apple, aws_cognito_identity_provider.google]
}

# ── Identity Pool: ID token → temporary STS creds ───────────────────────────────────────────────────────
resource "aws_cognito_identity_pool" "main" {
  identity_pool_name               = "${var.project_name}_${var.env}"
  allow_unauthenticated_identities = false # no guest access — every caller is an authenticated user
  allow_classic_flow               = false

  cognito_identity_providers {
    client_id               = aws_cognito_user_pool_client.app.id
    provider_name           = aws_cognito_user_pool.main.endpoint # cognito-idp.<region>.amazonaws.com/<pool id>
    server_side_token_check = true
  }
}

# ── The per-user IAM role assumed via the Identity Pool ─────────────────────────────────────────────────
# Trust: only the Identity Pool, only authenticated identities, may AssumeRoleWithWebIdentity.
data "aws_iam_policy_document" "user_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = ["cognito-identity.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "cognito-identity.amazonaws.com:aud"
      values   = [aws_cognito_identity_pool.main.id]
    }

    condition {
      test     = "ForAnyValue:StringLike"
      variable = "cognito-identity.amazonaws.com:amr"
      values   = ["authenticated"]
    }
  }
}

# Permissions: the SAME three S3 actions the daemon needs (PutObject/GetObject/RestoreObject), but scoped
# to the CALLER'S OWN prefix. `$${cognito-identity.amazonaws.com:sub}` is escaped so Terraform emits the
# literal IAM policy variable (NOT an HCL interpolation) — AWS substitutes the caller's identity id at eval
# time. THIS is the cross-user boundary; adversarially test it (a real token must get AccessDenied on
# another sub's prefix).
data "aws_iam_policy_document" "user_s3" {
  statement {
    sid    = "OwnPrefixReadWriteRestore"
    effect = "Allow"
    actions = [
      "s3:PutObject",
      "s3:GetObject",
      "s3:RestoreObject",
    ]
    resources = ["${aws_s3_bucket.vault.arn}/blobs/$${cognito-identity.amazonaws.com:sub}/*"]
  }
}

resource "aws_iam_role" "user" {
  name               = "${var.project_name}-${var.env}-user"
  path               = "/coldstorage/"
  assume_role_policy = data.aws_iam_policy_document.user_trust.json
}

resource "aws_iam_role_policy" "user_s3" {
  name   = "${var.project_name}-${var.env}-user-s3"
  role   = aws_iam_role.user.id
  policy = data.aws_iam_policy_document.user_s3.json
}

resource "aws_cognito_identity_pool_roles_attachment" "main" {
  identity_pool_id = aws_cognito_identity_pool.main.id

  roles = {
    authenticated = aws_iam_role.user.arn
  }
}
