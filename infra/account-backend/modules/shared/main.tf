# Placeholder — intentionally (almost) empty.
#
# In the adpharm-stack convention `shared` holds multi-tenant Route53 DNS zones. This
# service has no custom domain yet (v1 runs on Vercel's default *.vercel.app domain —
# Paddle's webhook target and the app's API base URL both work fine against it; a real
# domain is a later, YAGNI-deferred addition, same call infra/coldstorage made for DNS).
# Kept so `tf:account-backend:*` stays convention-shaped and there's an obvious home for a
# Route53 zone if/when a real domain (e.g. api.coldstorage.app) is chosen.
#
# `terragrunt plan` here returns "No changes" — that's expected.
