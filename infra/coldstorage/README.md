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

> **Migrated to Ben's own AWS account, 2026-07-27** ([`MIGRATION.md`](../../MIGRATION.md)). Applied and
> verified there; the old Adpharm stacks were destroyed the same day. Statuses below describe the
> CURRENT account.

## What it provisions (production-only for now)
- **S3 vault** (`coldstorage-production-<acct>`) — private, versioned, SSE-S3, written to
  directly as **Glacier Deep Archive** by the daemon. One lifecycle rule: abort orphaned
  multipart uploads. Nothing is ever auto-deleted.
- **Cognito** (`cognito.tf`) — user pool (passwordless: Google + email-OTP), identity pool, and the
  per-user IAM role scoped to `blobs/${cognito-identity.amazonaws.com:sub}/*`. This is the daemon's
  ONLY identity: it exchanges a sign-in for short-lived STS credentials and holds no long-lived key.
- **Pre-sign-up Lambda** (`lambda.tf`) — one email = one account, linking Google and email-code
  sign-ins into a single `sub`/vault.

> There is deliberately **no daemon IAM user**. `iam.tf` used to define one, with a long-lived access
> key exported through a handoff file into the macOS Keychain. It was already retired in practice —
> the daemon has authenticated via Cognito since 2026-07-14, and `coldstored` refuses to start without
> an identity pool — so the AWS account migration deleted it rather than recreate a standing all-access
> key in a fresh account (2026-07-27). Nothing seeds credentials any more.

## Divergences from the reference (intentional)
| Reference (Vercel app) | Here (Mac daemon + vault) | Why |
| --- | --- | --- |
| Vercel-OIDC role | **Cognito identity pool → per-user STS** | nothing runs on Vercel; the daemon is a launchd process on the user's Mac. It holds no long-lived key — creds are scoped to the signed-in user's own prefix. |
| Vercel env vars + DNS | **none** | no web frontend. Outputs are wired into the daemon's launchd env instead. |
| `shared` = Route53 zones | **empty placeholder** | no DNS. Kept so the shared-first task surface holds; obvious home for future cross-env resources. |
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
