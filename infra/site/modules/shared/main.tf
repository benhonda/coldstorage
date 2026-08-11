# Intentionally empty — DNS is NOT Terraform's concern for this component.
#
# `coldstorage.sh` (the marketing site's apex domain) is managed ENTIRELY IN VERCEL — the
# domain + DNS records are added/owned in the Vercel dashboard, not via Route53 (Ben's call,
# 2026-07-05). So unlike the adpharm-stack `terraform.md` DNS convention (Route53 zone in
# `shared` + record in `stack`), there is no zone or record to manage here.
#
# NARROWED, not reversed, 2026-08-10: `infra/coldstorage/modules/stack/auth-domain.tf` DOES manage two
# records in this zone, via the Vercel provider. That is not a contradiction of the call above. The
# records here are the apex/www ones Vercel writes for itself — nothing computed, nothing to drift, so
# Terraform would only be in the way. Those two are the opposite: ACM's validation challenge and
# Cognito's CloudFront hostname are both produced by that plan, so leaving them to the dashboard would
# mean a two-pass apply and a hand-copied duplicate of a Terraform value. The rule is "whoever computes
# the value owns the record", and for this component that is still nobody.
#
# Kept as an empty module so `tf:site:*` stays convention-shaped (the tasks plan `shared`
# first). `terragrunt plan` here returns "No changes" — that's expected.
