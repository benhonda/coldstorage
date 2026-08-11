# Pre-sign-up trigger: ONE EMAIL = ONE ACCOUNT (PROD.md "same email, two sign-in methods" — decided
# 2026-07-17). A Google first sign-in links into the native (email-code) user with the same VERIFIED
# email — or mints a native shell user and links into that — so both sign-in methods always resolve to
# the same user-pool `sub`, and therefore the same key-blob and S3 prefix. Without this, the same
# person gets two zero-knowledge vaults that cannot be merged after the fact.
#
# The decision table + the takeover guards live in lambda/pre-signup/decide.ts (unit-tested); this
# file only packages + wires it. `task tf:coldstorage:lambda:build` produces dist/index.mjs (bundled
# by bun, AWS SDK v3 left external — the nodejs runtime provides it); plan/apply depend on that task.
#
# Dependency shape (deliberate, breaks the classic cycle): role → function → user pool (lambda_config)
# → role POLICY (a separate resource referencing the pool arn). Don't inline the policy on the role.

data "archive_file" "pre_signup" {
  type        = "zip"
  source_file = "${path.module}/lambda/pre-signup/dist/index.mjs"
  output_path = "${path.module}/lambda/pre-signup/dist/pre-signup.zip"
}

data "aws_iam_policy_document" "lambda_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "pre_signup" {
  name               = "${var.project_name}-${var.env}-pre-signup"
  path               = "/coldstorage/"
  assume_role_policy = data.aws_iam_policy_document.lambda_trust.json
}

# CloudWatch logging only — the Cognito permissions are the separate policy below (cycle note above).
resource "aws_iam_role_policy_attachment" "pre_signup_logs" {
  role       = aws_iam_role.pre_signup.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_lambda_function" "pre_signup" {
  function_name    = "${var.project_name}-${var.env}-pre-signup"
  role             = aws_iam_role.pre_signup.arn
  filename         = data.archive_file.pre_signup.output_path
  source_code_hash = data.archive_file.pre_signup.output_base64sha256
  handler          = "index.handler"
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  # Worst case is ListUsers + AdminDeleteUser + AdminCreateUser + AdminLinkProviderForUser in
  # sequence — well under 10s, but the 3s default leaves no headroom for a cold start on top.
  timeout = 10
}

# Exactly the four operations the decision table can execute, on THIS pool only.
data "aws_iam_policy_document" "pre_signup_cognito" {
  statement {
    sid    = "LinkAccountsOnOwnPool"
    effect = "Allow"
    actions = [
      "cognito-idp:ListUsers",
      "cognito-idp:AdminCreateUser",
      "cognito-idp:AdminDeleteUser",
      "cognito-idp:AdminLinkProviderForUser",
    ]
    resources = [aws_cognito_user_pool.main.arn]
  }
}

resource "aws_iam_role_policy" "pre_signup_cognito" {
  name   = "${var.project_name}-${var.env}-pre-signup-cognito"
  role   = aws_iam_role.pre_signup.id
  policy = data.aws_iam_policy_document.pre_signup_cognito.json
}

# Cognito (this pool only) may invoke the function.
resource "aws_lambda_permission" "pre_signup_cognito" {
  statement_id  = "AllowCognitoPreSignUp"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.pre_signup.function_name
  principal     = "cognito-idp.amazonaws.com"
  source_arn    = aws_cognito_user_pool.main.arn
}

# ══ Custom email sender: ColdStorage's own branded one-time-code email ═══════════════════════════
#
# Cognito's default mail comes from no-reply@verificationemail.com with an AWS-shaped body — for a
# passwordless product where the code IS the sign-in, that email is the product's first impression.
# This trigger replaces it: Cognito hands the code to our function (KMS-encrypted, AWS Encryption SDK)
# and the function sends a branded message through CD2 from the verified m.coldstorage.sh sender.
#
# LOAD-BEARING: once `custom_email_sender` is set, Cognito sends NO email of its own — not for
# sign-in, not for sign-up. If this function is broken or undeployed, nobody can sign in. There is no
# partial mode and no fallback (AVOID4); the function throws on every failure so the app can say so.
#
# The code is in lambda/custom-email-sender/ (template + copy unit-tested, same shape as pre-signup);
# `task tf:coldstorage:lambda:build` bundles it, and plan/apply depend on that task.

data "archive_file" "custom_email_sender" {
  type        = "zip"
  source_file = "${path.module}/lambda/custom-email-sender/dist/index.mjs"
  output_path = "${path.module}/lambda/custom-email-sender/dist/custom-email-sender.zip"
}

# The CD2 API key, stored once out-of-band by `task tf:coldstorage:cd2-key` — same pattern as the
# Google OAuth creds above, and for the same reason: no secret in the repo, no TF_VAR shell exports.
data "aws_ssm_parameter" "cd2_api_key" {
  name = "/coldstorage/cd2-api-key"
}

# ── The KMS key Cognito encrypts codes with ──────────────────────────────────────────────────────
# Symmetric, as required. Two principals touch it: Cognito (via a one-time grant that the IAM
# principal running `apply` creates when it sets lambda_config — hence that principal needs
# kms:CreateGrant, which the root delegation below allows an account admin to have), and the
# function's role (kms:Decrypt, granted by its IAM policy further down).
resource "aws_kms_key" "email_codes" {
  description             = "${var.project_name}-${var.env} — encrypts Cognito one-time codes en route to the custom email sender"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.email_codes_key.json
}

resource "aws_kms_alias" "email_codes" {
  name          = "alias/${var.project_name}-${var.env}-email-codes"
  target_key_id = aws_kms_key.email_codes.key_id
}

# Standard root delegation ONLY: it hands authorization to IAM, which is where both grants actually
# live (the function's kms:Decrypt policy below, and the admin's kms:CreateGrant). Naming the Lambda
# role here as well would be a second place to maintain the same permission — and would make the key
# depend on the role while the role's policy depends on the key.
data "aws_iam_policy_document" "email_codes_key" {
  statement {
    sid       = "EnableIAMPolicies"
    effect    = "Allow"
    actions   = ["kms:*"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
  }
}

# ── The function ─────────────────────────────────────────────────────────────────────────────────
resource "aws_iam_role" "custom_email_sender" {
  name               = "${var.project_name}-${var.env}-custom-email-sender"
  path               = "/coldstorage/"
  assume_role_policy = data.aws_iam_policy_document.lambda_trust.json
}

resource "aws_iam_role_policy_attachment" "custom_email_sender_logs" {
  role       = aws_iam_role.custom_email_sender.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# Decrypt, on this key only. The function never encrypts — Cognito does that.
data "aws_iam_policy_document" "custom_email_sender_kms" {
  statement {
    sid       = "DecryptOwnPoolCodes"
    effect    = "Allow"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.email_codes.arn]
  }
}

resource "aws_iam_role_policy" "custom_email_sender_kms" {
  name   = "${var.project_name}-${var.env}-custom-email-sender-kms"
  role   = aws_iam_role.custom_email_sender.id
  policy = data.aws_iam_policy_document.custom_email_sender_kms.json
}

resource "aws_lambda_function" "custom_email_sender" {
  function_name    = "${var.project_name}-${var.env}-custom-email-sender"
  role             = aws_iam_role.custom_email_sender.arn
  filename         = data.archive_file.custom_email_sender.output_path
  source_code_hash = data.archive_file.custom_email_sender.output_base64sha256
  handler          = "index.handler"
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  # A person is staring at an empty inbox while this runs: one KMS decrypt, one template render, one
  # CD2 call. Comfortably sub-second warm; the headroom is for a cold start on a 3MB bundle.
  timeout = 15
  # Rendering React costs more than the 128MB default wants to give, and on Lambda memory buys CPU —
  # 512MB is the cheap way to keep a cold start off the critical path of someone signing in.
  memory_size = 512

  environment {
    variables = {
      KMS_KEY_ARN = aws_kms_key.email_codes.arn
      # The wordmark is lowercase by brand rule (site ds/wordmark.tsx); m.coldstorage.sh is the
      # sending domain verified in CD2.
      MAIL_FROM   = var.mail_from
      CD2_API_KEY = data.aws_ssm_parameter.cd2_api_key.value
    }
  }
}

# Retries are LOAD-BEARING here, not incidental. Custom sender triggers are the one Cognito trigger
# type invoked asynchronously ("Except for Custom sender Lambda triggers, Amazon Cognito invokes
# Lambda functions synchronously" — Cognito docs), so a throw never reaches the person signing in;
# what it does reach is Lambda's async retry machinery. Two retries turn a transient CD2 blip into a
# code that arrives a moment late instead of never. Pinned explicitly because the whole failure
# posture in index.ts depends on this number, and a silent default is a bad thing to depend on.
resource "aws_lambda_function_event_invoke_config" "custom_email_sender" {
  function_name          = aws_lambda_function.custom_email_sender.function_name
  maximum_retry_attempts = 2
}

# Explicit log group so retention is a decision rather than "never expires" by default. These logs
# hold masked addresses and CD2 message ids — long enough to answer "did my code send last week?",
# not a permanent archive of who signed in.
resource "aws_cloudwatch_log_group" "custom_email_sender" {
  name              = "/aws/lambda/${aws_lambda_function.custom_email_sender.function_name}"
  retention_in_days = 30
}

resource "aws_lambda_permission" "custom_email_sender_cognito" {
  statement_id  = "AllowCognitoCustomEmailSender"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.custom_email_sender.function_name
  principal     = "cognito-idp.amazonaws.com"
  source_arn    = aws_cognito_user_pool.main.arn
}
