# Custom managed-login domain — `auth.coldstorage.sh` in place of the `amazoncognito.com` prefix host.
#
# ── WHY THIS EXISTS (2026-08-10) ──────────────────────────────────────────────────────────────────────
# Google's consent screen names the host it is about to redirect to. Your app name + logo only REPLACE
# that hostname once the OAuth client passes Google's brand verification — and verification requires
# proving ownership of the client's authorized domain in Search Console. `amazoncognito.com` is Amazon's,
# so on the prefix domain that verification can never pass: every user signing in with Google would keep
# reading a raw AWS hostname on the one screen where a backup product can least afford to look
# unfamiliar. A domain we own is not cosmetic here, it is the only route to a branded consent screen.
#
# The prefix domain in cognito.tf STAYS. A user pool may carry both a prefix and a custom domain, and
# keeping it means this is not a flag day: builds already in the wild keep working against the host that
# was baked into them. The one documented asymmetry (AWS): only the CUSTOM domain serves
# `/.well-known/openid-configuration`. Nothing consumes discovery — the app builds `/oauth2/authorize`
# and `/oauth2/token` directly (ui/src/main/auth/oauth.ts) — so it costs us nothing.
#
# ── WHY THE DNS RECORDS ARE TERRAFORM'S HERE, WHEN THE SITE'S ARE NOT ─────────────────────────────────
# `infra/site` deliberately leaves `coldstorage.sh` DNS in the Vercel dashboard (see
# infra/site/modules/shared/main.tf) — those are apex/www records Vercel writes for itself: nothing
# computed, nothing to drift. Both records below are the opposite: their names and values are produced
# BY THIS PLAN (ACM's challenge, Cognito's CloudFront hostname). Hand-copying them into a dashboard would
# mean a two-pass apply every time and a hand-maintained duplicate of a Terraform value — exactly the
# by-hand maintenance PILLAR3 exists to remove. So this component gets the Vercel provider, for DNS only.

# ── The Vercel provider (DNS only) ────────────────────────────────────────────────────────────────────
# Same shape as infra/site and infra/account-backend: the API token lives in SSM and its PARAMETER NAME
# comes from the root Taskfile, so the token is account-scoped and moves with the account rather than
# with this component. The value never appears in this repo.
data "aws_ssm_parameter" "vercel_token" {
  name = var.vercel_token_ssm_param
}

provider "vercel" {
  api_token = data.aws_ssm_parameter.vercel_token.value
  team      = var.vercel_team_slug
}

variable "vercel_team_slug" {
  type        = string
  description = "Vercel team that owns the coldstorage.sh zone (from root inputs). Only used to scope the DNS records below."
}

variable "vercel_token_ssm_param" {
  type        = string
  description = "Name of the SSM SecureString holding the Vercel API token (from root inputs, whose value is the Taskfile). Never the token itself."
}

variable "auth_custom_domain" {
  type        = string
  default     = ""
  description = <<-EOT
    Custom managed-login host for the user pool, e.g. `auth.coldstorage.sh`. Empty (default) = keep the
    `<prefix>.auth.<region>.amazoncognito.com` host only.

    Requires the zone (the host minus its first label) to be a domain served by Vercel DNS whose PARENT
    already resolves — Cognito refuses a custom domain whose parent has no A record, as anti-hijacking.
    `coldstorage.sh` satisfies this by being the live marketing site.

    Only meaningful alongside a federated IdP; ignored when `enable_google_idp`/`enable_apple_idp` are
    both false, since without OAuth there is no managed-login page to serve.
  EOT

  validation {
    condition     = var.auth_custom_domain == "" || length(split(".", var.auth_custom_domain)) >= 3
    error_message = "auth_custom_domain must be a subdomain of a registrable domain (e.g. auth.coldstorage.sh), not a bare domain — Cognito requires a resolvable parent."
  }
}

locals {
  # Gated on OAuth as well as the var: a custom domain with no federated IdP would serve a login page
  # nothing links to, while still owning a cert and two DNS records.
  custom_domain_enabled = local.oauth_enabled && var.auth_custom_domain != ""

  auth_labels = split(".", var.auth_custom_domain)
  # `auth` + `coldstorage.sh` — the Vercel `vercel_dns_record` API takes the zone and the subdomain
  # separately, unlike Route53's fully-qualified names. Both are "" when the feature is off, which is
  # harmless because every resource below is count-gated.
  auth_subdomain = local.auth_labels[0]
  auth_dns_zone  = join(".", slice(local.auth_labels, 1, length(local.auth_labels)))

  # ACM's DNS challenge for the cert. One domain (no SANs) ⇒ exactly one record. Reached through the
  # count splat + `one()` rather than `[0]` so it evaluates to null — not an index error — when the
  # custom domain is off. Deliberately NOT a `for_each` over `domain_validation_options`: that is the
  # canonical AWS example but its map keys come from a computed set, which can make Terraform refuse to
  # plan. With a single domain there is nothing to iterate.
  cert_challenge = one(flatten(aws_acm_certificate.auth[*].domain_validation_options))

  # THE host the app talks to — one value, never two, so no consumer has to decide which is current.
  # Custom domain when there is one, prefix host otherwise, "" when sign-in isn't configured at all
  # (which the app reads as dogfood mode — see ui/src/main/auth/config.ts).
  managed_login_host = (
    local.custom_domain_enabled ? var.auth_custom_domain :
    local.oauth_enabled ? "${one(aws_cognito_user_pool_domain.main[*].domain)}.auth.${var.aws_region}.amazoncognito.com" :
    ""
  )
}

# ── The certificate ───────────────────────────────────────────────────────────────────────────────────
# MUST be in us-east-1 regardless of the pool's region: Cognito fronts a custom domain with CloudFront,
# which is global and only reads certs from N. Virginia. Hence the aliased provider generated in root.hcl.
resource "aws_acm_certificate" "auth" {
  count    = local.custom_domain_enabled ? 1 : 0
  provider = aws.us_east_1

  domain_name       = var.auth_custom_domain
  validation_method = "DNS"

  lifecycle {
    # ACM won't let a cert in use be destroyed; make the replacement first so a cert change is a
    # rotation rather than an outage of the sign-in page.
    create_before_destroy = true
  }
}

# ── CAA: without this the certificate above CANNOT ISSUE ──────────────────────────────────────────────
# `coldstorage.sh` already carries apex CAA records naming pki.goog, sectigo.com and letsencrypt.org.
# CAA is deny-by-omission: once ANY CAA record exists, a CA not named in the relevant set is forbidden
# to issue, and Amazon is not in that set. DNS validation would still have succeeded and then issuance
# would have failed — the failure lands one step later than you'd expect, which is what makes this worth
# a resource rather than a footnote.
#
# It goes on the APEX, and it cannot go on `auth`. Scoping it to the subdomain is tighter and per
# RFC 8659 §3 would work — the CA walks up from the exact name and stops at the first CAA RRset — but a
# CNAME must be the ONLY record at its owner name (RFC 1034/2181), and `auth` needs the CNAME below.
# Vercel enforces this and rejects the pair. Tried it that way first (2026-08-10); the two requirements
# are simply mutually exclusive at one name.
#
# So this ADDS a fourth CAA record to the apex set, next to the existing pki.goog / sectigo.com /
# letsencrypt.org ones. It does not replace or manage those — CAA is a multi-record RRset and Terraform
# owns only the record it created. The cost is honest and worth stating: Amazon may now issue for any
# name under coldstorage.sh, not just this host. Acceptable because the same person owns the domain and
# the AWS account, and the apex already delegates trust to three public CAs.
#
# No `issuewildcard` — nothing here needs a wildcard cert, and CAA should grant only what is used.
resource "vercel_dns_record" "auth_caa" {
  count = local.custom_domain_enabled ? 1 : 0

  domain  = local.auth_dns_zone
  name    = "" # apex — Vercel's spelling for the zone root
  type    = "CAA"
  ttl     = 60
  value   = "0 issue \"amazon.com\""
  comment = "Authorizes ACM to issue for ${var.auth_custom_domain}. Managed by infra/coldstorage."
}

resource "vercel_dns_record" "auth_cert_validation" {
  count = local.custom_domain_enabled ? 1 : 0

  domain = local.auth_dns_zone
  # ACM hands back a fully-qualified name with a trailing dot; Vercel wants it relative to the zone.
  name    = trimsuffix(trimsuffix(local.cert_challenge.resource_record_name, "."), ".${local.auth_dns_zone}")
  type    = local.cert_challenge.resource_record_type
  value   = local.cert_challenge.resource_record_value
  ttl     = 60
  comment = "ACM DNS challenge for the Cognito managed-login cert. Managed by infra/coldstorage."
}

# Blocks until ACM has actually seen the record and ISSUED the cert. Load-bearing ordering, not a
# formality: Cognito rejects a custom domain whose certificate is still PENDING_VALIDATION.
resource "aws_acm_certificate_validation" "auth" {
  count    = local.custom_domain_enabled ? 1 : 0
  provider = aws.us_east_1

  certificate_arn         = aws_acm_certificate.auth[0].arn
  validation_record_fqdns = [trimsuffix(local.cert_challenge.resource_record_name, ".")]

  # The CAA record is a dependency of ISSUANCE, not of validation, and nothing in the resource graph
  # would infer that on its own — this resource is where issuance is awaited, so the ordering is
  # declared here. Without it Terraform is free to create the CAA record last and the wait times out.
  depends_on = [vercel_dns_record.auth_cert_validation, vercel_dns_record.auth_caa]
}

# ── The domain itself ─────────────────────────────────────────────────────────────────────────────────
# `managed_login_version` is intentionally unset, matching the prefix domain in cognito.tf — both hosts
# then render the SAME sign-in page, so moving the app across is invisible to users. Setting it here
# alone would silently give the two hosts different login UIs.
resource "aws_cognito_user_pool_domain" "custom" {
  count = local.custom_domain_enabled ? 1 : 0

  domain          = var.auth_custom_domain
  user_pool_id    = aws_cognito_user_pool.main.id
  certificate_arn = aws_acm_certificate.auth[0].arn

  depends_on = [aws_acm_certificate_validation.auth]
}

# Points the subdomain at the CloudFront distribution Cognito just created. A CNAME is correct because
# this is a subdomain, not an apex — no ALIAS/ANAME gymnastics needed.
resource "vercel_dns_record" "auth" {
  count = local.custom_domain_enabled ? 1 : 0

  domain  = local.auth_dns_zone
  name    = local.auth_subdomain
  type    = "CNAME"
  ttl     = 60
  value   = "${aws_cognito_user_pool_domain.custom[0].cloudfront_distribution}."
  comment = "Cognito managed login (${var.auth_custom_domain}). Managed by infra/coldstorage."

  # CNAME exclusivity again, this time as an ORDERING constraint. The CAA record above moves off this
  # name to the apex; nothing in the graph connects the two, so Terraform is free to attempt this CNAME
  # while the CAA still occupies `auth` — which is exactly the conflict that failed the apply on
  # 2026-08-10. Declaring the edge makes the move happen first.
  depends_on = [vercel_dns_record.auth_caa]
}
