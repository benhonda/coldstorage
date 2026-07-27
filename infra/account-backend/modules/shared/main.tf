# Placeholder — intentionally empty. Read the note about the OIDC provider before adding one.
#
# In the adpharm-stack convention `shared` holds multi-tenant Route53 DNS zones. This service has no
# custom domain (v1 runs on Vercel's default *.vercel.app — Paddle's webhook target and the app's API
# base URL are both fine against it), so there is nothing here.
#
# ── WHY THE VERCEL OIDC PROVIDER IS *NOT* MANAGED HERE (checked against the live account 2026-07-27) ──
# During the AWS account migration this file briefly DID create `aws_iam_openid_connect_provider.vercel`,
# on the reasoning that Adpharm's account had one only because some older Adpharm project made it, and
# our own account should own it properly. Then we looked: the new account ALREADY has
# `oidc.vercel.com/benhonda` (audience `https://vercel.com/benhonda`), created 2026-07-19 by Ben's
# `vercel-log-drain` project.
#
# So the situation is identical, and the `data` lookup in modules/stack/oidc.tf is the honest model:
#   - AWS allows exactly ONE OIDC provider per issuer URL, account-wide. It is a shared singleton.
#   - It is already Terraform-managed — just in a different repo. It is not unmanaged, it is not ours.
#   - If ColdStorage adopted it into this state, `terragrunt destroy` here would delete the provider
#     `vercel-log-drain` authenticates with. A teardown of one project must not break a sibling.
#
# If ColdStorage ever lands in an account with no Vercel projects at all, the provider genuinely won't
# exist and the data source will fail on the first plan — that is the moment to create it, and this is
# where it would go.
#
# `terragrunt plan` here returns "No changes" — that's expected.
