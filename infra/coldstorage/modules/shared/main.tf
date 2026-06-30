# Placeholder — intentionally (almost) empty.
#
# In the adpharm-stack convention `shared` holds multi-tenant Route53 DNS zones, and the
# task surface always plans it first. ColdStorage has NO web frontend and NO DNS (it's a
# Mac daemon + a private S3 vault), so there is nothing shared across environments today.
# We keep this root so `tf:coldstorage:*` stays convention-shaped and so there's an obvious
# home for genuinely cross-env resources if they ever appear (e.g. a download domain for
# restore links, or an account-level OIDC provider when Cognito lands).
#
# `terragrunt plan` here returns "No changes" — that's expected.
