# Intentionally empty — DNS is NOT Terraform's concern for this component.
#
# `coldstorage.sh` (the marketing site's apex domain) is managed ENTIRELY IN VERCEL — the
# domain + DNS records are added/owned in the Vercel dashboard, not via Route53 (Ben's call,
# 2026-07-05). So unlike the adpharm-stack `terraform.md` DNS convention (Route53 zone in
# `shared` + record in `stack`), there is no zone or record to manage here.
#
# Kept as an empty module so `tf:site:*` stays convention-shaped (the tasks plan `shared`
# first). `terragrunt plan` here returns "No changes" — that's expected.
