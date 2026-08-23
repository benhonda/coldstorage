# `infra/coldstorage` — the ColdStorage vault

Terragrunt root for ColdStorage's AWS storage. Follows the adpharm-stack `terraform.md`
**conventions** (container layout, centralized state, ENV-scoped, shared-first, `~>` pins,
verify-with-plan / never-apply) but **diverges in content** because ColdStorage is a Mac
daemon + a private S3 vault, not a Vercel web app.

> The Terraform/Terragrunt **source** here (`.tf`/`.hcl`) IS committed to this public repo —
> that's the point of IaC. What's gitignored is state + secret-bearing artifacts: `.terraform/`,
> `.terragrunt-cache/`, `*.tfvars`, and the daemon-creds handoff file (`.gitignore`'s
> "Terraform / Terragrunt" section). Before `git add infra/`, sanity-check `git status` for
> stray state — the pre-commit gitleaks hook (`task hooks:install`) is the backstop.

## What it provisions (production-only for now)
- **S3 vault** (`coldstorage-production-<acct>`) — private, versioned, SSE-S3, written to
  directly as **Glacier Deep Archive** by the daemon. One lifecycle rule: abort orphaned
  multipart uploads. Nothing is ever auto-deleted.
- **Cognito** (`cognito.tf`) — user pool (passwordless: Google + email-OTP), identity pool, and the
  per-user IAM role scoped to `blobs/${cognito-identity.amazonaws.com:sub}/*`. This is the daemon's
  ONLY identity: it exchanges a sign-in for short-lived STS credentials and holds no long-lived key.
- **Pre-sign-up Lambda** (`lambda.tf`) — one email = one account, linking Google and email-code
  sign-ins into a single `sub`/vault.
- **Custom email sender Lambda** (`lambda.tf`) — the branded one-time-code email, sent through CD2
  from `m.coldstorage.sh` instead of Cognito's own `no-reply@verificationemail.com`. Cognito encrypts
  the code with the KMS key alongside it and invokes this function *instead of sending anything
  itself*: if the function is broken, nobody can sign in. Its CD2 API key comes from SSM
  (`task tf:coldstorage:cd2-key`, one-time) — the plan fails loudly until that key exists.
  Cognito invokes custom sender triggers **asynchronously**, so a failure is invisible to the person
  signing in *and* to their app — Lambda retries twice, and after that the only trace is the
  function's `Errors` metric. That metric is what `alerts.tf` watches.
- **Alerting** (`alerts.tf`) — an SNS topic plus two CloudWatch alarms on the email sender, because
  otherwise "nobody can sign in" and "a quiet Tuesday" look identical. `AsyncEventsDropped` is the
  serious one (retries exhausted — that person's code is never coming); `Errors` is the early warning
  and may fire on a blip a retry already fixed. The
  destination address is in SSM (`task tf:coldstorage:alert-email`), not in the repo. Note that an
  email subscription starts *pending*: AWS sends a confirmation link, and until someone clicks it the
  topic notifies nobody — a successful apply is not proof the alarm can reach you.
- **Managed-login custom domain** (`auth-domain.tf`) — `auth.coldstorage.sh`, so Google's consent
  screen names a host we own instead of `amazoncognito.com`, which can never pass Google's brand
  verification because Amazon owns it. Carries a us-east-1 ACM cert (CloudFront's requirement, not a
  preference) and the two Vercel DNS records that point at it. The prefix domain stays live alongside
  it, so builds already in the wild keep working.

> There is deliberately **no daemon IAM user**. `iam.tf` used to define one, with a long-lived access
> key exported through a handoff file into the macOS Keychain. It was already retired in practice —
> the daemon has authenticated via Cognito since 2026-07-14, and `coldstored` refuses to start without
> an identity pool — so the AWS account migration deleted it rather than recreate a standing all-access
> key in a fresh account (2026-07-27). Nothing seeds credentials any more.

## Divergences from the reference (intentional)
| Reference (Vercel app) | Here (Mac daemon + vault) | Why |
| --- | --- | --- |
| Vercel-OIDC role | **Cognito identity pool → per-user STS** | nothing runs on Vercel; the daemon is a launchd process on the user's Mac. It holds no long-lived key — creds are scoped to the signed-in user's own prefix. |
| Vercel env vars | **none** | no web frontend. Outputs are wired into the daemon's launchd env instead. |
| DNS in the dashboard (`infra/site`) | **two records in Terraform** | `infra/site` leaves `coldstorage.sh` DNS to Vercel because those records are apex/www ones Vercel writes itself. The two here (`auth-domain.tf`) have names and values *computed by the plan* — ACM's challenge, Cognito's CloudFront host — so hand-copying them would mean a two-pass apply and a duplicate of a Terraform value. Hence the Vercel provider, DNS only. |
| `shared` = Route53 zones | **empty placeholder** | no Route53 zone at all — the zone lives in Vercel. Kept so the shared-first task surface holds; obvious home for future cross-env resources. |
| prod + staging default | **production-only** | the pipeline is proven by the Core test suite (in-process, no S3); a staging Deep Archive bucket = 180-day-min early-deletion fees for zero added coverage. Staging stays a trivial `cp -r` away. |
| R2 / Cloudflare | **deferred** | only the (later) UI browse/thumbnail view needs it; add as a sibling concern then. |

## Use (all via the Taskfile — no raw commands)
**Provision (devcontainer — has terragrunt + SSO):**
```sh
task login                                # AWS SSO (profile: see Taskfile `vars.AWS_PROFILE`)
task tf:coldstorage:plan  ENV=production   # plans shared (no-op) then the env — REVIEW
task tf:coldstorage:apply ENV=production   # user runs this; never the agent
```
**Wire the daemon** (terragrunt is container-only; launchd is Mac-only — the gitignored handoff file
crosses on the bind mount):
```sh
# in the devcontainer, after apply:
task tf:coldstorage:creds-export    # TF outputs (bucket/region/Cognito ids — NO secrets) → coldstorage/.local/daemon-creds.env
# then on the Mac:
task daemon:mac:bootstrap               # build + install the LaunchAgent
task daemon:mac:doctor                  # health check: launchd state · getStatus
```
There is no credential step, and nothing to rotate. The daemon gets short-lived STS credentials when the
user signs in, scoped by IAM to that user's own `blobs/<identity-id>/` prefix; the handoff file carries
public client config only, so a leak of it discloses nothing.
