# ColdStorage — Going to Prod (multi-user) — Design & Delivery Plan

> The SSOT for taking ColdStorage from **single-operator dogfooding** to **real downloaded, paying,
> multi-user prod**. Read [`ROADMAP.md`](./ROADMAP.md) first for what's already built/proven. This doc
> owns the *new* surface: identity, per-user storage isolation, zero-knowledge keys, billing, distribution.
> Decisions here were locked with Ben on 2026-06-29; don't re-litigate them, refine the *how*.

## Decisions in force (locked 2026-06-29)
- **Distribution: direct download, Developer ID + notarization.** NOT the Mac App Store — its App Sandbox
  would break our daemon + unix-socket + FSEvents + watch-any-folder architecture, and it mandates Apple
  IAP. We own updates + pricing, no Apple cut.
- **Billing: Paddle (Merchant of Record).** Paddle is the legal seller — handles global VAT/sales tax,
  chargebacks, invoicing. We integrate their checkout + webhooks; we are not the merchant of record.
- **Encryption: true zero-knowledge, user-derived keys.** We cannot read user bytes. **Forces a recovery
  mechanism** (a one-time recovery code) — without it a forgotten password = data gone forever, which
  would break the "stuff you can't lose" promise. The recovery code is **non-optional**.
- **Auth: Cognito** — email/password baseline + **Sign in with Apple** (smooth on macOS). Default unless
  revisited.
- **One shared vault bucket, per-user prefix isolation** (not per-user buckets — those hit account caps).

## Architecture

### Identity & AWS credentials (verified vs aws-sdk-swift + Cognito IAM docs, 2026-06-29)
- **Cognito User Pool** = authentication (sign-up/in, email + Apple IdP). Issues a user-pool ID token.
- **Cognito Identity Pool** = authorization → exchanges that ID token for **short-lived STS credentials**
  via `AssumeRoleWithWebIdentity`, assuming the **authenticated IAM role** below.
- **The daemon never holds a long-lived AWS key.** aws-sdk-swift ships a turnkey
  **`CognitoAWSCredentialIdentityResolver`** (`AWSSDKIdentity`): given `identityPoolId` + `logins`
  (the user-pool token) it fetches/caches/refreshes temp creds and exposes `updateLogins(...)` for
  re-auth. It plugs straight into `S3Client.S3ClientConfig(awsCredentialIdentityResolver:region:)`.
  → replaces the 3 default-chain `S3ClientConfiguration(region:)` sites. The pipeline is untouched.

### Per-user S3 isolation (the load-bearing security boundary)
- The authenticated IAM role's S3 policy scopes every action to **`blobs/${cognito-identity.amazonaws.com:sub}/*`**.
  AWS substitutes the caller's identity id at eval time, so user A's temp creds **physically cannot**
  read/write user B's objects. This is the AWS-documented pattern (`cognito-identity.amazonaws.com:sub`
  policy variable) and it is the *entire* cross-user boundary — it must be adversarially tested (try to
  GET/PUT another sub's prefix with a real token and confirm `AccessDenied`).
- **S3 key layout changes:** `blobs/<hash>` → **`blobs/<cognito-sub>/<hash>`**. The daemon prefixes every
  blob key with the caller's identity id (resolved once at startup from the resolver / a `whoami` call),
  or the policy variable has nothing to match. Ripples to: upload key construction, restore GET, and the
  journal's `s3Key` column. Journal stays per-install (local), so the sub-prefix is recorded in `s3Key`.

### Zero-knowledge key hierarchy (refines the existing envelope crypto)
Our crypto is **already** envelope encryption — `Crypto.swift`: a per-blob random **DEK** (AES-256-GCM)
encrypts frames; the DEK is stored **wrapped** under a KEK in the journal `blobs.wrappedDEK` column;
`KeyProvider` is just `func userKEK() throws -> SymmetricKey`. ZK swaps *what produces the KEK* — but
naively deriving the KEK straight from the password would make a password change (new KEK) orphan every
`wrappedDEK`. So we introduce a proper hierarchy (1Password/Bitwarden-style):

```
password ──Argon2id(salt_pw)──▶ KEK_pw ─┐
                                          ├─▶ unwrap ──▶  MasterKey (MK, random, per-user, never leaves device decrypted)
recovery code ─Argon2id(salt_rc)─▶ KEK_rc ┘                     │
                                                                ├──wraps──▶ per-blob DEKs  (journal.wrappedDEK, byte-identical to today)
server stores ONLY:  wrappedMK_pw, wrappedMK_rc, salts          │
(both ciphertext; server/AWS never see MK or password)          ▼
                                            DEK ──▶ AES-256-GCM frames ──▶ S3 (Deep Archive)
```

- **MK** is a random 256-bit key minted once at signup. It is the `userKEK()` the wrap/unwrap code already
  expects — so `wrap()`/`unwrap()`/`blobCrypto`/UploadEngine/RestoreEngine are **unchanged**.
- The MK is stored **twice, wrapped**: under `KEK_pw` (Argon2id of password) and under `KEK_rc` (Argon2id
  of the one-time recovery code). Both ciphertexts + their salts live **server-side** (so a new device can
  fetch + unwrap with the password) — this is the encrypted **key-blob**, the only new server-stored secret
  material, and it's zero-knowledge (we hold ciphertext only).
- **Password change** = re-wrap MK under the new `KEK_pw`. DEKs untouched, no re-encryption of data.
- **Recovery code** = shown once at signup, unlocks MK if the password is lost. Lose both = data is
  unrecoverable *by design* (honest ZK; we never claim we can recover it).
- New `KeyProvider` impl: **`UserMasterKeyProvider`** (derives KEK_pw via Argon2id, unwraps MK). Need an
  Argon2id dependency (CryptoKit has no Argon2 — evaluate swift-sodium / a vetted Argon2 package).
- **Cross-device** now genuinely needs the server-side index (the deferred R2/portability piece): the
  wrapped MK + the journal/manifest must be fetchable on a fresh install. ZK makes this load-bearing, not
  optional.

### Billing (Paddle MoR)
- Paddle-hosted checkout + customer portal (no card data touches us). **Webhooks** drive subscription
  lifecycle → our account backend flips `subscription_active`. Uploads are gated on an active sub.
- Retrieval fees: the existing `getPricing` rate card stays the quote SSOT; actual charging for restores
  is a later refinement (subscription-gates-storage first).

### Account backend (new)
- Minimal API linking **Cognito identity ↔ Paddle subscription ↔ the encrypted key-blob**. Responsibilities:
  (1) serve/store the wrapped-MK key-blob (ZK), (2) receive Paddle webhooks + expose `subscription_active`,
  (3) optionally broker the Cognito identity id. Stateless-ish; smallest thing that works (the existing
  infra is AWS — Lambda + API Gateway + a tiny DynamoDB table is the path-of-least-resistance, TBD in P4).

### Distribution
- electron-builder already configured. Add: **Developer ID Application** cert + notarization
  (`mac.notarize: true` + Apple creds), confirm nested Swift binaries under `Contents/Resources/bin` are
  signed with hardened runtime, **auto-update** (electron-updater + the `zip` target already emitted), and
  a download page. The bundled `coldstored` keeps its `-sectcreate` Info.plist for the Photos grant.

## Delivery plan — phases, each with a proof gate
1. **Infra foundation — DONE ✅ + APPLIED (2026-06-30). Cognito is LIVE in prod.** Cognito User Pool (+ Apple
   IdP, var-gated off) + Identity Pool + **authenticated IAM role** scoped to
   `blobs/${cognito-identity.amazonaws.com:sub}/*`, in `infra/coldstorage/modules/stack/cognito.tf`
   (+ `variables.tf`/`outputs.tf`; committed in `8b25956`). *Gate met:* plan was **6 add / 0 change / 0
   destroy** (additive — untouched vault/daemon) with the **literal** `${cognito-identity.amazonaws.com:sub}`
   rendered (the `$${` escape), then **`terragrunt apply ENV=production` → `Apply complete! Resources: 6
   added`**. The user pool / client / identity pool / user-role exist in prod (`ca-central-1`). The public
   client ids (not secrets) are available via `cd infra/coldstorage/live/production && terragrunt output`;
   they'll flow to the daemon/app through the **gitignored handoff in 2c** — kept OUT of tracked docs
   (public repo).
2. **Daemon credential seam — DONE ✅ (2026-07-01, all 3 sub-steps landed).** Built in gated sub-steps:
   - **2a — per-user key as journal SSOT: DONE ✅ (2026-06-30, 71 Core tests green).** `keyPrefix` threads
     `BlobPlan`(`Models.swift`)→`BlobPlanner`→`UploadEngine.run(keyPrefix:)` to the real S3 PUT; it's stored
     as `s3Key`; **`RestoreEngine` reads the stored key** via new `Journal.blobS3Key(_:)` (the keystone fix —
     a `blobs/<cognito-id>/<id>` object is now found, not missed). Backward-compatible (default `"blobs"`);
     proven by `PerUserPrefixTests` (prefix reaches store + journal; default path unchanged).
   - **2b — DONE ✅ (2026-07-01, 72 Core tests green + `ui:typecheck`/`ui:test` green).** New `CognitoAuth`
     actor (`Sources/ColdStorageCore/CognitoAuth.swift`) owns a single long-lived
     `CognitoAWSCredentialIdentityResolver` (built once, unauthenticated, at init — the resolver makes no
     network call until something needs credentials, confirmed by reading the vendored SDK source, not just
     the docs); `authenticate(idToken:)` calls `updateLogins` on it (so `S3Client` — which holds a reference,
     not a copy — signs every later call as this user) and separately calls `CognitoIdentityClient.getId`
     (the resolver never exposes the identity id it resolves internally) to set
     `vaultPrefix = "blobs/\(identityId)"`. `coldstored/main.swift` is opt-in gated on 3 new env vars
     (`COLDSTORE_COGNITO_IDENTITY_POOL_ID`/`_USER_POOL_PROVIDER`/`_REGION`) — unset ⇒ today's default
     credential chain + `"blobs"`, byte-for-byte the old behavior; set ⇒ `S3Client` is built from
     `CognitoAuth.resolver`. `DaemonService` takes `cognitoAuth: CognitoAuth?` and `performRun` reads
     `await cognitoAuth?.vaultPrefix ?? "blobs"` into `engine.run(keyPrefix:)` — one edit point covers
     scheduled runs + both deposit paths (all three call `performRun`). New control command
     `authenticate idToken=…` (`DaemonService.handle`) → `AuthDTO{ok,identityId}`; errors clean on a daemon
     with no `cognitoAuth` configured. `protocol.ts` `Auth`/`authenticate` added (typecheck + `ui:test`
     green) — the login UI itself is still Phase 5. `CognitoAuthTests` proves the actor starts
     unauthenticated (`vaultPrefix == nil`) with no network call.
   - **2c — DONE ✅ (2026-07-01).** `tf:coldstorage:creds-export` now also emits
     `COLDSTORE_COGNITO_IDENTITY_POOL_ID` + `COLDSTORE_COGNITO_USER_POOL_PROVIDER` (composed from the
     already-applied `cognito_identity_pool_id`/`cognito_user_pool_id`/`aws_region` TF outputs — no new
     Terraform output needed, so no apply required for this sub-step) into the gitignored handoff. Both
     consumers read them: **`daemon:install`** substitutes 2 new plist placeholders
     (`__COGNITO_IDENTITY_POOL_ID__`/`__COGNITO_USER_POOL_PROVIDER__`) into
     `launchd/com.theadpharm.coldstored.plist.template`, blank when the handoff predates 2c; **`ui:config`**
     writes the same 2 values into the packaged app's `config.json`, read by `ui/src/main/daemon.ts`'s
     `AppConfig`/`daemonEnv` (same pass-through pattern as `bucket`/`region`/`awsProfile`) so the Electron-app
     daemon supervisor picks them up too. `coldstored/main.swift`'s gate now treats an **empty string** the
     same as unset (`nonEmpty(_:)`) — needed because the plist/config.json always set the keys now, blank
     when not configured, instead of omitting them. Verified: `daemon:build:dev` + `daemon:test` (72 green) +
     `ui:typecheck` + `ui:test` (51 green); all 3 new/changed shell blocks passed `bash -n`.

   Why **atomic** to actually upload as a user: the IAM policy only grants `blobs/<sub>/*`, so the credential
   swap (2b) and the per-user prefix (2a) must both be live or every PUT is `AccessDenied`. All of 2a/2b/2c
   are now live end-to-end (daemon wiring + the handoff that populates it) — what's left is a real Cognito
   user/token to actually exercise the path, which is Phase 5 (app auth UX) or a manually-minted token.
   *Gates:* unit test (a custom prefix round-trips; restore reads the stored key) + build green — **MET**.
   **LIVE gate** (real token → own-prefix PUT ok, cross-prefix `AccessDenied`) is Ben's: re-run
   `task tf:coldstorage:creds-export` (devcontainer) → `task daemon:bootstrap` or `task ui:bootstrap` (Mac)
   to pick up the new handoff values, then a manually-minted Cognito token to call `authenticate` over the
   control socket.
3. **ZK crypto — primitives DONE ✅ (2026-07-01, 79 Core tests green).** New
   `Sources/ColdStorageCore/ZeroKnowledgeKeys.swift`: `KeyBlob` (wrappedMK under BOTH a password- and a
   recovery-code-derived Argon2id key, + their salts + the ops/mem tuning used, stored alongside since the
   raw KDF — unlike libsodium's self-describing `pwhash_str` — doesn't embed its params) and
   `ZeroKnowledgeKeys` (`mint`/`unlock`/`unlockWithRecoveryCode`/`rewrapPassword`/
   `resetPasswordUsingRecoveryCode`). MK is a random 256-bit key — the existing `userKEK()` `wrap()`/
   `unwrap()`/`EnvelopeCipher`/`UploadEngine`/`RestoreEngine` are byte-for-byte UNCHANGED, only what
   *produces* the KEK is new. `UserMasterKeyProvider: KeyProvider` is the drop-in production conformer
   (construction IS the unlock; a wrong secret throws `.wrongSecret` up front, never silently). **Argon2id
   library decided: swift-sodium** (wraps libsodium, which defaults `crypto_pwhash` to Argon2id) — chosen
   over `calebkleveter/Argon2` (unmaintained since 2018) and `Argon2Swift` (unmaintained since 2023, no
   Linux platform declared); verified against the actual vendored SDK/library source, not just docs.
   **Linux gotcha found + fixed:** Ubuntu 24.04's apt `libsodium-dev` is 1.0.18, which predates AEGIS
   (needs 1.0.19+) that swift-sodium's Linux binding references — build failed with "cannot find
   'crypto_aead_aegis128l_...'". Fixed by building current libsodium (1.0.22) from the official source
   release instead of apt (new `task daemon:setup` sub-task `_libsodium-dev`, Linux-only — Apple platforms
   get a prebuilt XCFramework bundled in the SPM package itself, no system lib needed). *Gate met:* unit
   tests — password change re-wraps MK without touching DEKs (proven: a DEK wrapped under MK before a
   password change still unwraps clean after, no re-encryption) ✅; recovery code unlocks (to the SAME MK
   as the password path) ✅; round-trip still byte-identical through the real `EnvelopeCipher` ✅; wrong
   password/recovery code fails closed (AES-GCM auth tag rejects, no silent garbage key) ✅; production
   Argon2id tuning (`defaultOpsLimit`/`defaultMemLimit`, libsodium's "Moderate" preset) verified to
   actually derive a key in this environment (~1.4s), not just the lightened test tuning ✅.
   **NOT yet wired into `coldstored/main.swift`** (unlike Phase 2's `CognitoAuth`) — there's nowhere
   legitimate to source a `KeyBlob` from yet (Phase 4, the account backend) or a password/recovery code
   from (Phase 5, the sign-in UI), so wiring it now would have no real caller. That wiring is now this
   phase's remaining work, landing naturally with P4/P5.
4. **Account backend — SCAFFOLDED ✅, infra APPLIED ✅ (2026-07-01), app not yet deployed.** (Infra
   = Terraform-provisioned Vercel project settings/env vars/IAM role, applied for real — see below.
   App deploy = actually pushing the Hono code to Vercel so it serves requests; that hasn't happened
   yet, and is a separate step from `terragrunt apply`.) Stack decided with Ben: **Hono on
   Vercel + Neon/Drizzle** (not Lambda+DynamoDB) — Vercel-project infra is already the adpharm-stack
   convention (`references/terraform.md`), Neon is that convention's DB default, and this needed no AWS
   SDK/credentials at runtime (Cognito ID-token verification is a plain JWKS check), so the daemon's
   `aws-oidc.md` credential dance doesn't apply here. New `account-backend/` (Taskfile `backend:*`):
   `accountsTable` (Drizzle, one row per Cognito **User Pool** `sub` — NOT the Identity Pool identity id
   S3 keys are prefixed with, see cognito.tf; this service never touches S3) holds the `KeyBlob` fields
   verbatim (base64 text — blind ciphertext storage, never decoded here) + `subscriptionActive` +
   Paddle customer/subscription ids. Routes: `GET/PUT /key-blob` (Cognito-ID-token-authenticated, via
   `aws-jwt-verify`'s `CognitoJwtVerifier`), `GET /entitlement` (`{active: bool}`), `POST /webhooks/paddle`
   (`@paddle/paddle-node-sdk`'s `webhooks.unmarshal` HMAC-verifies `paddle-signature`; a subscription is
   linked to a user via `customData.cognitoSub`, which the Paddle checkout must set — Paddle.js
   `customData` param, still TODO wherever checkout gets built in P5). Subscription status → `active`
   mapped by `isActiveStatus` (`active`/`trialing` → true), the one piece with a real unit test
   (`paddle-status.test.ts`) since everything else needs a live DB/Cognito/Paddle to exercise.
   **`bun run typecheck` + `bun test` green.** Infra: new `infra/account-backend/` (Taskfile
   `tf:account-backend:*`) mirrors `infra/coldstorage`'s Terragrunt layout but — unlike coldstorage,
   which deliberately opted OUT of the Vercel convention — this IS the Vercel app, so it gets the OIDC
   role + TF-managed env vars in full. The Cognito user-pool id/client-id are read via a cross-component
   Terragrunt `dependency` on `infra/coldstorage/live/production` (SSOT — no hand-copying `terragrunt
   output` values). Vercel project **created — `coldstorage-account-backend`** (`prj_IhOlkinKj2zIuHQ
   BBTJhdP7s008w`, verified via the Vercel API to confirm the name matches exactly what the OIDC trust
   condition expects), wired into `live/production/terragrunt.hcl`. **`terragrunt plan` is clean against
   real AWS + Vercel providers for BOTH stacks** (production `9 to add`; staging `10 to add`) — also
   confirmed the account's `oidc.vercel.com/adpharm` OIDC provider and the `/adpharm/vercel-api-token-
   benhonda` SSM param already exist (an open question going in; now resolved). Custom domains DECIDED
   (2026-07-02): **`api.coldstorage.sh`** (production) / **`api-staging.coldstorage.sh`** (staging
   custom environment). `coldstorage.sh` is registered with its nameservers delegated to Vercel DNS
   (`ns1/ns2.vercel-dns.com`). **Deliberately NOT Terraform-managed** — Ben manages the domains by
   hand in the Vercel dashboard (his experience: mixing Vercel-DNS-hosted domains with the Vercel TF
   provider is a mess). A `vercel_project_domain` version was built + plan-verified (1 to add per
   stack, staging bound via `custom_environment_id`) then reverted on that call — don't re-add it.
   **Staging added (2026-07-01)** — Ben flagged the sandbox-Paddle case: webhooks need a stable deployed
   URL (not local `vercel dev`) and sandbox test events must never touch production subscription data.
   `live/staging/terragrunt.hcl` is a Vercel **custom environment** (branch-tracked on `staging`) within
   the SAME project — not a second project. `modules/stack/vercel-env-vars.tf` now implements the full
   `is_prod`/`has_staging` split from `terraform.md`: production's manual secrets go `sensitive=true`
   / `target=["production"]` only (now that staging exists to cover preview/development); staging's stay
   non-sensitive (Vercel can't pull sensitive vars for preview/dev — the convention deliberately keeps
   these pullable so `vercel env pull` can fetch real sandbox values for local testing).
   **Correction (2026-07-01):** briefly second-guessed this into `target=["preview"]` +
   `git_branch="staging"` based on my own read of the generic `vercel/terraform-provider-vercel` docs
   (worried `target`/`custom_environment_ids` don't narrow each other) — Ben caught it and pointed back
   at `terraform.md`'s own documented shape, which already answers this (`target=["preview","development"]`
   **+** `custom_environment_ids`, exactly what was there originally). Reverted to the skill's convention
   as written — it's the org's vetted pattern, not something to relitigate from generic docs mid-task.
   Re-verified clean: production `9 to add`, staging `10 to add`.
   `PADDLE_ENVIRONMENT` (`"production"`/`"sandbox"`) is TF-managed, not a manual secret — it's fully
   determined by which stack this is, not external secret material. Cognito is NOT duplicated for
   staging (`infra/coldstorage` has no staging tier) — both stacks read the same production Cognito
   outputs; auth isn't what's being sandboxed.
   **Vercel link/pull wired (2026-07-01)** — `task link`/`task pull` (generic pickers, `select`+`case`,
   matching the `tf:plan`/`tf:apply`/`tf:init` picker convention added the same day) and their direct
   `link:account-backend`/`pull:account-backend` forms. `pull` writes `account-backend/.env.vercel`
   (bare `vercel env pull` defaults to the `development` target, which by construction only resolves to
   staging's non-sensitive values — production's are `sensitive=true` and don't target `development` at
   all, so there's no accidental-prod-pull path, no flags needed). `backend:dev`/`backend:db:push` load
   `.env.vercel` then `.env` via `bun --env-file` (later wins) — `.env` is an optional local override on
   top of the pulled staging baseline, never auto-loaded by bun/drizzle-kit/`vercel dev` on its own for a
   non-standard filename like this, hence the explicit flags. **Not yet tried for real** — needs
   `task link` run once against an authenticated `vercel` CLI, which this environment can't do (no
   Vercel login here); the picker/dispatch mechanics are verified, the actual pull isn't.
   **Infra APPLIED for real (confirmed 2026-07-01 via `terragrunt state list`)** — both stacks are live,
   not just plan-clean: production shows all 9 resources in state (the OIDC role +
   `coldstorage-account-backend-production-vercel`, the 5 TF-managed vars, the 3 manual-secret
   placeholders), staging shows all 10 (same set + the `staging` custom environment); re-plans on both
   come back "No changes." This must have been run directly by Ben — not by me (I don't run `apply`).
   **Unverified from here:** whether the 6 manual-secret values (3 per stack) still hold their
   Terraform-written placeholder (`SET_IN_VERCEL_DASHBOARD`) or have already been replaced with real
   values in the Vercel dashboard — production's are `sensitive=true` (can't be read back at all, by
   design) and staging's weren't checked (technically readable via the Vercel API, but pulling live
   secret material into a doc/transcript isn't something to do just to satisfy a checkpoint). **Gate not
   yet met — remaining blockers are all non-Terraform, Ben-only steps:** (1) create a Neon project
   (`coldstorage-account-backend`, branches `production`/`staging` — Neon's own one-project-many-branches
   model, not two projects); (2) create a Paddle **sandbox** account (staging) and, later, a live account
   (production) — pull each one's webhook secret + API key; (3) set the 6 real secret values in the
   Vercel dashboard (confirm they're not still placeholders, per the open question above); (4) `task
   link` once, then `task pull` for staging's values, `task backend:db:push` against staging; production's
   DB gets pushed by pointing `.env`'s `DATABASE_URL` at it directly (not pullable, see above). Only once
   those land does "webhook flips state; upload blocked when inactive" become testable end-to-end — that
   gate is unchanged from before.
5. **App auth + paywall UX** — sign-in/up + recovery-code capture + subscribe flow in the Electron UI;
   token handed to the daemon. *Gate:* Ben signs up fresh → subscribes → deposits → restores, on a Mac.
6. **Sign + notarize + ship** — Developer ID signing + notarization + auto-update + download page. *Gate:*
   a notarized build launches Gatekeeper-clean on a non-dev Mac and self-updates.

## Open sub-decisions (don't block P1; flagged for when their phase lands)
- **Encryption password vs auth credential (LOAD-BEARING for P3 wiring, NOT for the primitives).** With
  **Sign in with Apple there is no password** to derive KEK_pw from — so the encryption secret that
  protects the MasterKey **cannot** be the login. Options: (a) a *separate* "encryption passphrase" the
  user sets at signup (one more thing to remember, but clean ZK), (b) make the recovery code the *primary*
  MK protector + escrow a device-local copy of MK in the macOS Keychain (smooth per-device UX, recovery
  code is the cross-device/new-device key), (c) email/password users derive from password, Apple users get
  a generated passphrase. Leaning (b) — it matches "remote SSD" muscle memory (no passphrase prompt every
  launch) while staying ZK. **Still open** — doesn't block the primitives (`ZeroKnowledgeKeys` supports
  both a password path and a recovery-code path unconditionally, per-account choice of which is "primary"
  is a P4/P5 wiring decision) and Apple Sign-In is `enable_apple_idp`-gated OFF today, so it isn't a live
  gap yet. Decide before Apple Sign-In ships (P5 at the earliest, or whenever `enable_apple_idp=true`).
- ~~**Argon2id library** for Swift (swift-sodium vs a focused Argon2 wrapper) — P3.~~ **DECIDED ✅
  (2026-07-01): swift-sodium.** See Phase 3 above.
- **Account backend shape** (Lambda+APIGW+DynamoDB vs a managed app) — P4.
- **Apple Sign-in prerequisites** — Apple Developer Services ID + key (Ben provides) — P1 (var-gated; email
  /password works without it).
- **Free trial / plan tiers / retrieval-fee charging** — product/economics (private `strategy/`) — P4.
