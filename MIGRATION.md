# AWS account migration — Adpharm → Ben's own account

> # ✅ COMPLETE — 2026-07-27
>
> ColdStorage runs entirely in Ben's own AWS account. The Adpharm stacks were destroyed the same day:
> vault, Cognito pools, pre-sign-up Lambda, every IAM role and the retired daemon user — all confirmed
> gone. **Kept as the record of why**, not as a runbook; the decommission tasks it describes
> (`login:legacy`, `tf:legacy:destroy`) have been removed from the Taskfile.
>
> Verified against real AWS before teardown:
> - the per-user boundary is a **literal** IAM policy variable — AWS stored
>   `blobs/${cognito-identity.amazonaws.com:sub}/*`, so the `$${` escape survived;
> - `s3:RestoreObject` is absent from the user role and present only on the backend's OIDC roles;
> - a test blob landed at `blobs/<identity-id>/…` as `DEEP_ARCHIVE` — per-user isolation in practice;
> - a **paid retrieval round trip** reached S3 (thaw issued), proving Vercel OIDC → AssumeRole →
>   RestoreObject works in the new account;
> - all five stacks plan **"No changes"**.
>
> **The old vault was deleted, not reproduced.** Ben chose not to bulk re-upload (the source files live
> on his Mac); the new vault holds a test object. 49 objects / 6.88 GB were destroyed with the account.

Started 2026-07-27. The goal is narrow and total: **ColdStorage's infrastructure stops living in
Adpharm's AWS account and lives in Ben's own.** Nothing about the product changes. Vercel, Neon, Paddle,
the `coldstorage.sh` domain and the GitHub repo are untouched — they were never in AWS.

## What was actually entangled

Three components had AWS resources (`infra/coldstorage`, `infra/account-backend`, `infra/site`), and
three *more* things turned out to be Adpharm-account fixtures that this repo silently borrowed:

| Borrowed fixture | Who used it | What happened to it |
| --- | --- | --- |
| `terraform-state-sensitive` (state bucket) | all three components | replaced by `coldstorage-sh-tfstate`, ours, created automatically on first plan |
| the `oidc.vercel.com/<team>` IAM OIDC provider | `account-backend` + `site`, via `data` lookups | **now ours**, created in `infra/account-backend/modules/shared` |
| `/adpharm/vercel-api-token-benhonda` (SSM) | the Vercel provider in both web components | moved to `/coldstorage/vercel-api-token`, stored via `task tf:vercel-token` |

None of the three existed in the new account, which is exactly why an account move is worth doing
deliberately rather than by copying resources: it's the only thing that surfaces what you were
depending on without knowing.

## Why this is a rebuild, not a data migration

Two resources are structurally non-portable, and they turn out to be the same problem:

- **Cognito can't be exported.** A user pool cannot be moved between accounts with its identities
  intact, and Identity Pool IDs are pool-scoped. A new account means a new pool, which means new
  `sub`s and new identity ids.
- **The vault's key layout is `blobs/<cognito-identity-id>/<hash>`.** So even a byte-perfect copy of
  the bucket would land every blob under a prefix that no user can reach, with each Mac's local
  journal (`s3Key` column) still pointing at the old ones.

Copying the data would therefore mean: bulk-thaw the entire vault out of Deep Archive (~48h, paid
retrieval), copy with rewritten keys, re-transition to Deep Archive (restarting the 180-day minimum),
**and** rewrite the journal on every Mac. Against that: the plaintext source files are still sitting on
Ben's Mac, `account-backend` production has never been deployed (`DATABASE_URL` is still the
placeholder), and there are no paying users.

**Decision (Ben, 2026-07-27): stand up a clean stack in the new account and re-upload from source.**
The old vault stays readable until the re-upload is verified, then it's destroyed.

## What changed in the repo

- **The account constants have one home: `Taskfile.yml`'s `vars:` block** — `AWS_PROFILE`,
  `AWS_REGION`, `COLDSTORE_TF_STATE_BUCKET`, `COLDSTORE_VERCEL_TEAM_SLUG`. They used to be restated
  across three `root.hcl` files and four `live/*/terragrunt.hcl` files. The roots now read them back
  out of the exported environment with `get_env(...)`, with **no defaults** — run outside `task tf:*`
  and Terragrunt fails naming the missing variable, rather than quietly planning against whatever
  account is ambient. The next account move is a change to four lines (PILLAR3).
- **The AWS profile is no longer written in HCL at all.** The AWS provider and the S3 backend both
  honour `AWS_PROFILE` natively, so restating it was only ever a second place to forget.
- **`check-aws-identity` now pins the account**, not just "logged in". It compares the live caller
  identity against the profile's own `sso_account_id` from `~/.aws/config` and refuses on a mismatch —
  the failure that matters now that both accounts are live on the same machine. The expected id is
  read from machine-local config rather than committed, keeping account ids out of this public repo.
- **The Vercel OIDC provider is Terraform-managed**, as an account-level singleton in
  `account-backend`'s `shared` unit (AWS allows exactly one provider per issuer URL, so it cannot be
  per-stack). `infra/site` reads it across the component boundary via a `dependency` block, which
  turns "apply shared first" from a convention into something Terragrunt enforces.
- **The Vercel role trust policies now pin `aud` as well as `sub`.** Defence in depth: the provider's
  `client_id_list` already constrains the audience, but it lives in a different unit that could be
  widened without anyone reading the role.
- **`mock_outputs` are restricted to `validate` and `plan`** on every `dependency` block, including the
  two that predate this work. These values become IAM trust principals and resource ARNs, where a
  placeholder applies perfectly cleanly and yields a role that silently trusts nobody.
- **`account-backend/src/aws.server.ts` stopped hardcoding the profile.** It resolved local-dev credentials with `fromSSO({ profile: "pharmer" })` — straight out of the adpharm-stack reference, and a hardcoded profile is a hardcoded account. It now calls `fromSSO()` and honours `AWS_PROFILE`. The code carries a note saying not to "restore" the literal just because the skill still shows it.
- **The retired daemon IAM user was deleted, not recreated.** `iam.tf` defined a long-lived access key whose
  secret was exported into the macOS Keychain via a handoff file. Nothing had used it since 2026-07-14 — the
  daemon authenticates as the signed-in user through Cognito STS, and `coldstored` refuses to start without an
  identity pool — so it was a standing all-access credential sitting in Terraform state for the benefit of two
  diagnostic tasks. Carrying it into a fresh account would have been pure inheritance of a liability. Gone with
  it: the credential outputs, `daemon:mac:creds`, the `credential_process` helper, the launchd `AWS_PROFILE`
  and the `awsProfile` app-config field. **The Mac cutover therefore has no credential step.**
- **State locking is on** (`use_lockfile = true`, S3-native conditional writes). There was none before,
  which was only safe because exactly one person ever ran it.

## Runbook

Everything is a Taskfile command. `task tf:*:apply` is Ben's to run — never the agent's.

### Phase 0 — get into the new account

```sh
task login                     # SSO into the new account
task check-aws-identity        # prints the account it resolved; refuses on a mismatch
task tf:reinit                 # drop .terragrunt-cache dirs still bound to Adpharm's backend
task tf:bootstrap              # create the state bucket (once per account, before any plan)
```

`tf:reinit` matters on an existing checkout: Terraform records which backend a working directory was
initialized against, so every plan otherwise dies with "Backend configuration block has changed". Do
**not** reach for `terraform init -migrate-state` — that copies Adpharm's state into the new bucket and
convinces Terraform that an empty account already contains a vault, a Cognito pool and four IAM roles.

### Phase 1 — the secrets Terraform reads but doesn't own

Only **one** thing to do here, because the account turned out to already have the other:

```sh
task tf:coldstorage:google-creds   # the Google OAuth client id + secret
```

The **Vercel API token is already in this account** as the SSM parameter `vercel-token-for-benhonda`,
set up by `vercel-log-drain`. It is account-scoped (one token per Vercel team), so ColdStorage reads it
rather than minting a second one — `COLDSTORE_VERCEL_TOKEN_SSM_PARAM` in the Taskfile points at it, and
`task tf:vercel-token` exists only to *rotate* it (which re-points every project in the account).

> The Google OAuth **client itself** lives in a Google Cloud project. If that project belongs to
> Adpharm's Google organisation, it is a second, separate migration — the Cognito side works either
> way, but check who owns it before treating this as finished.

### Phase 2 — build the new stacks

Order matters: `coldstorage` publishes the Cognito + bucket outputs the other two consume.

```sh
task tf:coldstorage:plan  ENV=production    # review — expect ~everything to be an ADD
task tf:coldstorage:apply ENV=production

# The Vercel stacks must ADOPT their live resources before their first apply — see below.
task tf:adopt-vercel SERVICE=account-backend ENV=production
task tf:adopt-vercel SERVICE=account-backend ENV=staging
task tf:account-backend:plan  ENV=production   # expect: 1 IAM role added, the AWS-pointing env vars updated
task tf:account-backend:apply ENV=production
task tf:account-backend:apply ENV=staging

task tf:site:apply ENV=production               # already adopted + planned: 1 to add, 0 to change
task tf:site:apply ENV=staging
```

#### Why the Vercel stacks need `tf:adopt-vercel`

The Vercel projects are **not migrating** — only the values that point at AWS are (`AWS_ROLE_ARN`,
`COGNITO_*`, `VAULT_BUCKET_NAME`). But the Terraform state that owned those env vars lived in Adpharm's
bucket, so with fresh state Terraform doesn't know they exist and plans to *create* ~10 variables per
stack that are already there. Vercel rejects a duplicate key+target, so the apply would die partway.

Deleting them first is not an option: five rows are Vercel **`sensitive`** (site prod `CD2_API_KEY`,
`TURNSTILE_SECRET_KEY`; account-backend prod `DATABASE_URL`, `PADDLE_API_KEY`, `PADDLE_WEBHOOK_SECRET`).
Vercel never returns a sensitive value over its API, so a deleted one can only come back from the system
that issued it — and `coldstorage.sh` and `api.coldstorage.sh` are both serving production.

Copying the old state across doesn't work either (tried, 2026-07-27): moving the projects between Vercel
teams **re-created every env var with a new id**, so every id in the old state is dead. Hence import.
Sensitive values import as `null`, and `ignore_changes = [value]` keeps Terraform away from them, so they
stay exactly as they are in Vercel.

**Ordering:** `account-backend` reads `infra/coldstorage`'s outputs and mock outputs are plan-only, so
apply coldstorage *before* importing account-backend. `site` has no such dependency.

**Then, by hand (these are outside Terraform by design):**

1. **Google OAuth redirect URI.** The Cognito hosted-UI domain embeds the account id, so it changed.
   Add the new `https://<new-domain>/oauth2/idpresponse` to the OAuth client's authorized redirect
   URIs — get the domain from `task tf:coldstorage:creds-export`'s output. **Sign-in is broken until
   this is done.**
2. **Enable OIDC federation** on both Vercel projects (Settings → Secure Backend Access), if it isn't
   already on for the team.
3. **Re-set the Vercel dashboard secrets** for any env var Terraform declares but doesn't own
   (`DATABASE_URL`, the Paddle keys, `CD2_API_KEY`, `TURNSTILE_SECRET_KEY`). Terraform rewrote
   `AWS_ROLE_ARN` / `COGNITO_*` / `VAULT_BUCKET_NAME` to point at the new account; it deliberately
   never touches these.
4. **Redeploy both Vercel projects — BOTH LANES.** This is not optional bookkeeping: Vercel env vars only
   take effect on a **new deployment**, so until you redeploy, the running instance still verifies tokens
   against the OLD Cognito pool and every authenticated call gets a bare 401. Production and **staging**
   are separate deployments; `ui:mac:live` talks to staging by default, so forgetting that lane looks
   exactly like a broken migration. Verify with `task backend:api:health ENV=staging|production` — it now
   reports the identity each deployment is actually wired to.

### Phase 3 — cut the Mac over

The new pool means a new account: new user-pool `sub`, new identity id, new S3 prefix. Nothing on the
Mac can be reused, so the cutover is "clear the old account's local state, repoint, sign in fresh".
**The old vault is untouched throughout** — the new config names a different bucket.

Everything below runs **on the Mac**, in this order. Quit `ColdStorage.app` first if it's open.

```sh
task daemon:mac:uninstall        # stop the LaunchAgent — the wipes below refuse while coldstored runs
task daemon:mac:sim-new-device   # drop vault.json, this device's OLD MasterKey escrow
task daemon:mac:reset:local      # drop every per-user journal (the old sub's index is orphaned now)
task ui:mac:config               # rewrite config.json from the re-exported handoff (new bucket + pool)
task daemon:mac:bootstrap        # build + install the LaunchAgent with the new bucket + pool
task daemon:mac:doctor           # launchd state + getStatus
task ui:mac:live                 # run the UI against it, and sign in with Google
```

Notes on the two that look odd:

- **`sim-new-device`** is named for its usual job (proving the new-device unlock path), but deleting
  `vault.json` is exactly right here: that file caches the MasterKey for the account you're leaving.
  Removing it guarantees the new account mints a fresh MK rather than reusing anything.
- **`reset:local`**, not `reset`. Journals are per-user under `<data dir>/users/` since the 2026-07-13
  session refactor; `reset` targets the older machine-wide layout.

You do **not** need to sign out first. The stored refresh token belongs to the old pool, so the silent
restore fails, logs `stored sign-in couldn't be restored (starting signed out)`, and deletes the session
file by itself (`auth/manager.ts`).

Then, in the app: **write down the new recovery code.** It is shown once. The old one unlocks nothing in
this account, and once the old vault is destroyed it unlocks nothing anywhere. Re-add the watched folders
and let the upload run — every file is new to this account, so it all re-uploads from source.

### Phase 4 — verify, then decommission

#### Deciding about the old vault

The re-upload is not happening, so the old vault's ~6.5 GiB (80 objects) is not being reproduced here.
Three honest options, and they should be chosen rather than defaulted into:

1. **Let it go.** The source files still live on Ben's Mac, there were never any customers, and this was
   dogfood data. Destroying it costs an early-deletion charge on the Deep Archive minimum and nothing else.
2. **Re-upload selectively.** Point the daemon at the folders actually worth keeping and let it deposit;
   the vault fills with what matters instead of everything.
3. **Copy it across.** Bulk-thaw, S3 Batch Copy with rewritten `blobs/<new-identity-id>/` prefixes,
   re-transition, then rewrite each Mac journal's `s3Key`. Only worth it if the sources are gone.

**Recommendation: (2), then (1)** — deposit anything genuinely irreplaceable, confirm it, then destroy the
old vault. It gets the account cleanly separated without a thaw bill or journal surgery.

Whichever is chosen, do not skip the verification below first.

- [ ] `task daemon:mac:doctor` clean, and `daemon:mac:live -- listFiles` shows the full tree
- [ ] `task daemon:mac:verify-aws` confirms a blob is really in the new bucket as `DEEP_ARCHIVE`
- [x] **a paid retrieval round trip against staging — MET 2026-07-27.** A restore of the test blob was
      quoted, paid through sandbox Paddle, and the thaw reached S3 (`ongoing-request="true"` on the
      object). Conclusive by elimination: `s3:RestoreObject` exists ONLY on the backend's OIDC role —
      the user's Cognito role provably lacks it — so the thaw existing at all proves webhook →
      Vercel-OIDC → AssumeRole → RestoreObject all work against the new account. Deep Archive
      standard-tier thaw completes within ~12h; `task daemon:mac:restore-wait` polls it hands-off.
- [ ] the cross-user boundary still denies: a real token must get `AccessDenied` on another `sub`'s prefix
- [ ] sign-in works via **both** Google and email-OTP, and lands on the same account (the pre-sign-up
      Lambda's one-email-one-account guarantee, re-proven on a fresh pool)

Only then:

```sh
task login:legacy         # SSO into the OLD Adpharm account
task tf:legacy:destroy    # picker, in dependency order — coldstorage last, behind a typed confirmation
```

Destroy `site` and `account-backend` first (both envs), then `coldstorage`. For the two Vercel
components the task first runs `state rm` on every `vercel_*` resource, because that old state still
describes the **live** env vars the new state now owns — destroying them from there would delete
production configuration out from under the account that took them over. Only the old IAM roles go.

Afterwards, in the old account: delete this repo's state objects under `terraform-state-sensitive` —
**they contain the old daemon's secret access key** — and confirm the vault bucket is gone. Deleting Deep Archive objects
before their 180-day minimum incurs early-deletion charges; that bill is expected, not a fault.

The `tf:legacy:*` tasks and `LEGACY_*` vars have been removed from `Taskfile.yml`. This file stays: the
reasoning in it (rebuild-not-copy, why the OIDC provider is read rather than owned, why the state bucket
is ours) is referenced from code comments in `infra/` and is the record of decisions that would otherwise
look arbitrary later.

## Open items

- **Who owns the Google Cloud project** holding the OAuth client (see Phase 1). If it sits in Adpharm's
  Google organisation, that's a second migration — the Cognito side works either way, but it's not
  really "off Adpharm" until that moves too.

## Resolved while planning this

- **Vercel team slug = `benhonda`** (confirmed by Ben 2026-07-27). The repo had carried `adpharm`, which
  was already stale before the migration began. Verified against the live provider: its audience is
  `https://vercel.com/benhonda`, which is exactly what the trust policies now pin.
- **The old vault is small.** 80 objects, ~6.5 GiB in Deep Archive (CloudWatch, 2026-07-27). Re-uploading
  is quick and the early-deletion charge on teardown is negligible — this decision was never close.
- **The destination account is not empty.** It already runs `vercel-log-drain`, which is why the OIDC
  provider and the Vercel API token already existed there. Both are read, not recreated.
- **The Vercel projects had already changed teams** (Adpharm → `benhonda`, `team_a3ACx1JLNDggKf0UiABsabkh`),
  and that re-created every environment variable with a new id. So the old state was doubly stale — wrong
  team scope *and* dead resource ids — which is what forced import over state-copying.
- **`site` is verified**: both stacks import cleanly and plan at **1 to add, 0 to change, 0 to destroy**
  (just the IAM role the new account lacks). Its env vars don't reference AWS, so nothing else moves.

## What is deliberately NOT done yet

Everything up to the first AWS write. The next command — `task tf:bootstrap` — creates the state bucket,
and every command after it creates or changes real infrastructure. Those are Ben's to run.
