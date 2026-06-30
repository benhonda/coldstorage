# Multi-user identity (the "go to prod" layer — see /workspace/PROD.md).
#
# Single-operator dogfooding uses the long-lived daemon IAM user in iam.tf. REAL downloaded users instead
# authenticate via Cognito and get SHORT-LIVED, per-user-scoped STS credentials — no shared key ever leaves
# our control, and user A's creds physically cannot touch user B's objects.
#
#   User Pool      = authentication (email/password + optional Sign in with Apple). Issues an ID token.
#   Identity Pool  = authorization: exchanges that ID token for temporary STS creds via
#                    AssumeRoleWithWebIdentity, assuming `aws_iam_role.user` below.
#   user role      = S3 scoped to blobs/${cognito-identity.amazonaws.com:sub}/* — the per-user boundary.
#
# The daemon picks these up with aws-sdk-swift's CognitoAWSCredentialIdentityResolver (the 3 S3Client
# sites swap from the default chain to this resolver — Phase 2). Verified vs aws-sdk-swift + Cognito IAM
# docs 2026-06-29.
#
# NOTE on zero-knowledge: Cognito is AUTH ONLY. A Cognito email password-reset restores ACCOUNT ACCESS
# (and thus S3 access to one's own prefix) but NEVER the encryption key — data is decryptable only with the
# user's password-or-recovery-code (the MasterKey hierarchy in PROD.md). Auth ≠ key recovery, by design.

# ── User Pool: email/password sign-up + sign-in ────────────────────────────────────────────────────────
resource "aws_cognito_user_pool" "main" {
  name                     = "${var.project_name}-${var.env}"
  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]

  password_policy {
    minimum_length    = 12
    require_lowercase = true
    require_uppercase = true
    require_numbers   = true
    require_symbols   = false
  }

  # Email-based account recovery (account access only — see the zero-knowledge note above).
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

# Hosted-UI domain — only needed for the Apple (OAuth) flow; gated with it.
resource "aws_cognito_user_pool_domain" "main" {
  count = var.enable_apple_idp ? 1 : 0

  domain       = "${var.project_name}-${var.env}-${data.aws_caller_identity.current.account_id}"
  user_pool_id = aws_cognito_user_pool.main.id
}

# ── App client: the desktop app. Public client (no secret — a desktop app can't keep one); SRP for
#    email/password, hosted-UI OAuth only when Apple is enabled. ──────────────────────────────────────────
resource "aws_cognito_user_pool_client" "app" {
  name            = "${var.project_name}-${var.env}-desktop"
  user_pool_id    = aws_cognito_user_pool.main.id
  generate_secret = false

  explicit_auth_flows = [
    "ALLOW_USER_SRP_AUTH",
    "ALLOW_REFRESH_TOKEN_AUTH",
  ]

  supported_identity_providers = compact([
    "COGNITO",
    var.enable_apple_idp ? "SignInWithApple" : "",
  ])

  # OAuth/hosted-UI is required for Apple; for email/password (SRP) it's unused. Gated so the default
  # email-only deployment doesn't carry dangling callback config.
  allowed_oauth_flows_user_pool_client = var.enable_apple_idp
  allowed_oauth_flows                  = var.enable_apple_idp ? ["code"] : []
  allowed_oauth_scopes                 = var.enable_apple_idp ? ["email", "openid", "profile"] : []
  callback_urls                        = var.enable_apple_idp ? var.app_oauth_callback_urls : []
  logout_urls                          = var.enable_apple_idp ? var.app_oauth_callback_urls : []

  token_validity_units {
    access_token  = "hours"
    id_token      = "hours"
    refresh_token = "days"
  }
  access_token_validity  = 1
  id_token_validity      = 1
  refresh_token_validity = 30

  depends_on = [aws_cognito_identity_provider.apple]
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
