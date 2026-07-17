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
