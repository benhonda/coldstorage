# AWS account migration — Adpharm → Ben's own account

> **Complete 2026-07-27.** ColdStorage runs entirely in Ben's own AWS account; the Adpharm stacks —
> vault, Cognito pools, pre-sign-up Lambda, every IAM role, the retired daemon user — were destroyed
> the same day. The runbook that got us here is gone with it; `git log` has it, and the tasks it drove
> (`tf:bootstrap`, `tf:reinit`, `tf:adopt-vercel`, `tf:vercel-token`) document themselves in
> `task --list`. **This file is kept for the decisions that still shape the repo** — the ones that look
> arbitrary in the code without them.

## Why it was a rebuild, not a data migration

Two resources are structurally non-portable, and they're the same problem. **Cognito can't be
exported** — a pool can't move between accounts with identities intact, so a new account means new
`sub`s and new identity ids. And **the vault's key layout is `blobs/<cognito-identity-id>/<hash>`**, so
even a byte-perfect bucket copy lands every blob under a prefix nobody can reach, with each Mac's
journal still pointing at the old keys. Copying would have meant a bulk thaw out of Deep Archive, a
rewrite-keyed copy, a re-transition restarting the 180-day minimum, *and* journal surgery on every Mac.

The old vault (80 objects, ~6.5 GiB of dogfood data) was **deleted, not reproduced** — the source files
live on Ben's Mac and there were no customers.

## Decisions that still shape the repo

- **Account constants have one home: `Taskfile.yml`'s `vars:`** (`AWS_PROFILE`, `AWS_REGION`,
  `COLDSTORE_TF_STATE_BUCKET`, `COLDSTORE_VERCEL_TEAM_SLUG`). The three `root.hcl` files read them back
  with `get_env` and **no defaults**, so running Terragrunt outside `task tf:*` fails naming the missing
  variable instead of quietly planning against whatever account is ambient. The next account move is a
  four-line change (PILLAR3).
- **The AWS profile is not written in HCL at all** — the provider and the S3 backend both honour
  `AWS_PROFILE` natively, so restating it was only ever a second place to forget.
- **`check-aws-identity` pins the account**, not just "logged in": it compares the live caller identity
  against the profile's own `sso_account_id` and refuses on a mismatch — the failure that matters now
  that two accounts are live on one machine. The expected id is read from machine-local config, never
  committed (public repo).
- **The Vercel OIDC provider is Terraform-managed as an account-level singleton** in
  `infra/account-backend/modules/shared` — AWS allows exactly one provider per issuer URL, so it cannot
  be per-stack. `infra/site` reads it across the component boundary via a `dependency`, which makes
  "apply shared first" enforced rather than remembered.
- **Vercel env vars were imported, never recreated.** Moving the projects between Vercel teams
  re-created every variable with a new id, so the old state was dead — and five rows are Vercel
  `sensitive`, which the API never returns, so a deleted one could only come back from whoever issued
  it. Hence `ignore_changes = [value]` on those: they import as `null` and Terraform stays away.
- **`account-backend/src/aws.server.ts` calls `fromSSO()` with no profile.** It came from the
  adpharm-stack reference as `fromSSO({ profile: "pharmer" })`, and a hardcoded profile is a hardcoded
  account. The file carries a note not to "restore" the literal just because the skill still shows it.
- **The retired daemon IAM user was deleted, not recreated.** A fresh account was the moment not to
  inherit a standing all-access key whose secret sat in Terraform state, serving two diagnostic tasks
  nothing had used since Cognito STS took over. Gone with it: the credential outputs, `daemon:mac:creds`,
  the `credential_process` helper, the launchd `AWS_PROFILE`, and the `awsProfile` app-config field —
  so the Mac cutover had no credential step.
- **State locking is on** (`use_lockfile = true`). There was none before, which was only ever safe
  because exactly one person ran it.

## Verified against real AWS before the teardown

- the per-user boundary is a **literal** IAM policy variable — AWS stored
  `blobs/${cognito-identity.amazonaws.com:sub}/*`, so the `$${` escape survived;
- `s3:RestoreObject` is absent from the user role and present only on the backend's OIDC roles;
- a test blob landed at `blobs/<identity-id>/…` as `DEEP_ARCHIVE`;
- **a paid retrieval round trip reached S3** — quoted, paid through sandbox Paddle, thaw issued.
  Conclusive by elimination: `RestoreObject` exists only on the backend's OIDC role, so the thaw
  existing at all proves webhook → Vercel OIDC → AssumeRole → RestoreObject in the new account;
- all five stacks plan **"No changes."**

## Still open

**Who owns the Google Cloud project** holding the OAuth client. If it sits in Adpharm's Google
organisation, that's a second migration — the Cognito side works either way, but it isn't really "off
Adpharm" until that moves too. Bears on the brand-verification work in [`PROD.md`](./PROD.md).
