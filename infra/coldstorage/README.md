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
- **Daemon IAM user** — least-privilege (`s3:PutObject` + `s3:GetObject` + `s3:RestoreObject`
  on `blobs/*` only), with an access key the daemon loads via the AWS SDK credential chain.

## Divergences from the reference (intentional)
| Reference (Vercel app) | Here (Mac daemon + vault) | Why |
| --- | --- | --- |
| Vercel-OIDC role | **IAM user + access key** | nothing runs on Vercel; the daemon is a launchd process. Multi-user → Cognito later (deferred), an SDK-edge swap. |
| Vercel env vars + DNS | **none** | no web frontend. Outputs are wired into the daemon's launchd env instead. |
| `shared` = Route53 zones | **empty placeholder** | no DNS. Kept so the shared-first task surface holds; obvious home for future cross-env resources. |
| prod + staging default | **production-only** | MinIO is our pipeline staging; a staging Deep Archive bucket = 180-day-min early-deletion fees for zero added coverage. Staging stays a trivial `cp -r` away. |
| R2 / Cloudflare | **deferred** | only the (later) UI browse/thumbnail view needs it; add as a sibling concern then. |

## Use (all via the Taskfile — no raw commands)
**Provision (devcontainer — has terragrunt + `pharmer` SSO):**
```sh
task login                                # AWS SSO (profile: pharmer)
task tf:coldstorage:plan  ENV=production   # plans shared (no-op) then the env — REVIEW
task tf:coldstorage:apply ENV=production   # user runs this; never the agent
```
**Wire the daemon** (terragrunt is container-only; Keychain/launchd are Mac-only — the gitignored
handoff file crosses on the bind mount):
```sh
# in the devcontainer, after apply:
task tf:coldstorage:creds-export    # TF outputs (incl. secret) → coldstorage/.local/daemon-creds.env (0600)
# then on the Mac:
task daemon:mac:bootstrap               # secret→Keychain + coldstorage profile, then build + install the LaunchAgent
task daemon:mac:doctor                  # health check: launchd state · AWS auth · getStatus
```
The daemon's IAM secret lives only in the macOS Keychain; the `credential_process` helper installs to a
**space-free** `~/.coldstorage/` (AWS splits `credential_process` on whitespace). Rotate the key by tainting
`aws_iam_access_key.daemon`, then re-run `creds-export` → `daemon:mac:creds`.
