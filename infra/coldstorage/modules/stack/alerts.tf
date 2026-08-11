# Operational alerting. This is the FIRST alerting in the repo, and it exists for one specific hole:
#
# Cognito invokes custom sender triggers ASYNCHRONOUSLY ("Except for Custom sender Lambda triggers,
# Amazon Cognito invokes Lambda functions synchronously" — Cognito docs). By the time the branded
# one-time-code function runs, the user's sign-in call has already returned "code sent". So if the
# send fails, the failure is invisible THREE times over: the person waiting sees a normal screen, the
# app sees a success, and Cognito swallows the error. Nothing is left but the function's CloudWatch
# metrics — and a metric nobody is watching is not observability (PILLAR5).
#
# Without these alarms, "nobody in the world can sign in" and "a quiet Tuesday" look identical.
#
# The topic is named generally, not after this one alarm: it is THE place ColdStorage ops alerts go,
# and the next alarm should attach here rather than grow a second topic.

resource "aws_sns_topic" "alerts" {
  name         = "${var.project_name}-${var.env}-alerts"
  display_name = "ColdStorage ${var.env} alerts"
}

# The destination address lives in SSM, NOT in this file — same reasoning as the CD2 key and the
# Google OAuth creds: this is a public repo, and a personal email address is exactly the kind of
# thing that shouldn't be committed to one. Store it once with `task tf:coldstorage:alert-email`.
data "aws_ssm_parameter" "ops_alert_email" {
  name = "/coldstorage/ops-alert-email"
}

# HEADS UP: an email subscription is created in "pending confirmation" state and AWS emails a
# confirmation link. Terraform cannot click it — until someone does, this topic notifies NOBODY.
# `apply` succeeding is therefore NOT proof the alarm can reach you; the confirmation click is.
resource "aws_sns_topic_subscription" "alerts_email" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = data.aws_ssm_parameter.ops_alert_email.value
}

# ── The alarms ───────────────────────────────────────────────────────────────────────────────────
# TWO of them, because "something failed" and "a person definitively never got their code" are
# different events and deserve different urgency. Per the Lambda metric definitions:
#
#   Errors             = invocations that ended in a function error. Each async RETRY is its own
#                        invocation, so one bad event that succeeds on retry still lands here.
#   AsyncEventsDropped = events dropped without ever executing successfully — "exhaust the maximum
#                        retry attempts" is listed as a cause. This is the metric that means a code
#                        was lost for good.
#
# Only alarming on Errors would cry wolf on self-healed blips; only alarming on Dropped would stay
# silent while the system quietly degrades. Both, with the wording telling you which one you got.

# Both alarms share the same shape, spelled out in each rather than hoisted into a local: with two
# resources, `x = local.defaults.x` on every line is more indirection than the duplication it saves.
# The shape is: one bad data point in five minutes is enough (there is no acceptable steady-state
# rate of failing to deliver a sign-in code), and `notBreaching` because a window with nobody
# signing in is not a failure — without it these would sit in INSUFFICIENT_DATA overnight and train
# everyone to ignore them.

# THE ONE THAT MEANS SOMEONE IS LOCKED OUT. Retries are exhausted; that person's code is never coming.
resource "aws_cloudwatch_metric_alarm" "custom_email_sender_dropped" {
  alarm_name = "${var.project_name}-${var.env}-custom-email-sender-DROPPED"
  alarm_description = join(" ", [
    "A ColdStorage sign-in code was PERMANENTLY LOST — retries are exhausted and the email was never sent.",
    "Cognito invokes this trigger asynchronously, so the person saw a normal 'code sent' screen, their app saw success, and they got nothing.",
    "They cannot sign in until this is fixed.",
    "Start with the function's CloudWatch logs; the usual causes are CD2 rejecting the send, a stale CD2 API key, or m.coldstorage.sh losing sending verification.",
  ])

  metric_name = "AsyncEventsDropped"
  dimensions  = { FunctionName = aws_lambda_function.custom_email_sender.function_name }

  namespace           = "AWS/Lambda"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = [aws_sns_topic.alerts.arn]
  # Say when it recovers too, so a resolved incident closes itself instead of leaving someone
  # wondering whether sign-in ever came back.
  ok_actions = [aws_sns_topic.alerts.arn]
}

# THE EARLY WARNING. May fire on a blip that the next retry fixed — that is intended. A code that
# only arrives after a retry is still a degraded sign-in, and for auth that is worth knowing about
# before it becomes the alarm above.
resource "aws_cloudwatch_metric_alarm" "custom_email_sender_errors" {
  alarm_name = "${var.project_name}-${var.env}-custom-email-sender-errors"
  alarm_description = join(" ", [
    "The branded one-time-code email failed at least once in five minutes.",
    "Lambda retries asynchronously, so this may already have healed itself — check whether it was followed by the DROPPED alarm, which means it did not.",
    "Either way something is wrong with sending: see the function's CloudWatch logs.",
  ])

  metric_name = "Errors"
  dimensions  = { FunctionName = aws_lambda_function.custom_email_sender.function_name }

  namespace           = "AWS/Lambda"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]
}

# NOT alarmed, deliberately: the pre-sign-up Lambda (lambda.tf). It is invoked SYNCHRONOUSLY, so its
# failures already surface — Cognito fails the sign-up and the app shows the message. It fails
# visibly by construction; this file exists for the one trigger that cannot.
