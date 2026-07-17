# ColdStorage — Going to Prod (multi-user) — Design & Delivery Plan

> The SSOT for taking ColdStorage from **single-operator dogfooding** to **real downloaded, paying,
> multi-user prod**. Read [`README.md`](./README.md) first for what's already built/proven. This doc
> owns the *new* surface: identity, per-user storage isolation, zero-knowledge keys, billing, distribution.
> Decisions here were locked with Ben on 2026-06-29; don't re-litigate them, refine the *how*.

## Decisions in force (locked 2026-06-29)
- **Distribution: direct download, Developer ID + notarization.** NOT the Mac App Store — its App Sandbox
  would break our daemon + unix-socket + FSEvents + watch-any-folder architecture, and it mandates Apple
  IAP. We own updates + pricing, no Apple cut.
- **Billing: Paddle (Merchant of Record).** Paddle is the legal seller — handles global VAT/sales tax,
  chargebacks, invoicing. We integrate their checkout + webhooks; we are not the merchant of record.
- **Encryption: true zero-knowledge, user-derived keys.** We cannot read user bytes. **Forces a recovery
  mechanism** (a one-time recovery code) — with passwordless auth (below) the recovery code is the ONLY
  human-held encryption secret, so it is **non-optional** and the whole ZK story rests on it.
- **Auth: Cognito, PASSWORDLESS (revised by Ben 2026-07-02; was email/password + Apple).** **Google IdP
  is the primary login** + Cognito **native email-OTP codes** as the no-Google path (Essentials tier;
  NOT magic links — those aren't Cognito-native and aren't worth custom auth Lambdas). **No passwords
  anywhere in the product.** Apple IdP stays var-gated off for later (direct download = no App Store
  mandate to offer it). Infra: `cognito.tf` (`sign_in_policy` = PASSWORD+EMAIL_OTP — AWS refuses to
  remove PASSWORD from the pool-level list (apply error 2026-07-02); passwordless is enforced by the
  app client having no password flows AND OTP users never possessing a password — plus `ALLOW_USER_AUTH`
  client flow; Google IdP + hosted-UI domain LIVE as of 2026-07-02, smoke-tested to the Google redirect).
- **One shared vault bucket, per-user prefix isolation** (not per-user buckets — those hit account caps).

## Architecture

### Identity & AWS credentials (verified vs aws-sdk-swift + Cognito IAM docs, 2026-06-29)
- **Cognito User Pool** = authentication (passwordless: Google IdP + email-OTP; Apple gated off). Issues a user-pool ID token.
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
`KeyProvider` is just `func userKEK() throws -> SymmetricKey`. ZK swaps *what produces the KEK*. A proper
hierarchy (1Password/Bitwarden-style) keeps the DEKs stable under any secret rotation — and with
**passwordless auth (2026-07-02) the password leg is RETIRED**: the recovery code is the only human-held
secret, wrapping the MK alone (recovery-code-only model, the old "option (b)"):

```
recovery code ─Argon2id(salt_rc)─▶ KEK_rc ──▶ unwrap ──▶  MasterKey (MK, random, per-user, never leaves device decrypted)
                                                                │
server stores ONLY:  wrappedMK_rc + salt                        ├──wraps──▶ per-blob DEKs  (journal.wrappedDEK, byte-identical to today)
(ciphertext; server/AWS never see MK or the code)               ▼
                                            DEK ──▶ AES-256-GCM frames ──▶ S3 (Deep Archive)

each signed-in device: MK cached in the macOS Keychain (per-device escrow — no prompt at launch)
```

- **MK** is a random 256-bit key minted once at signup. It is the `userKEK()` the wrap/unwrap code already
  expects — so `wrap()`/`unwrap()`/`blobCrypto`/UploadEngine/RestoreEngine are **unchanged**.
- The MK is stored **once, wrapped under `KEK_rc`** (Argon2id of the one-time recovery code); ciphertext +
  salt live **server-side** — the encrypted **key-blob**, the only new server-stored secret material, and
  it's zero-knowledge (we hold ciphertext only). A **new device** fetches the key-blob and unwraps it with
  the recovery code — day-to-day devices never re-enter it (Keychain-cached MK).
- **Recovery-code reissue** = any signed-in device (it holds MK) mints a new code and re-wraps: new
  `wrappedMK_rc` + salt to the server. DEKs untouched, no re-encryption of data — the same stability the
  old password-change path had.
- **Recovery code** = shown once at signup. Lose the code AND all signed-in devices = data is
  unrecoverable *by design* (honest ZK; we never claim we can recover it).
- **Known gap — new-device onboarding is conflated with lockout recovery; device-to-device trust not
  built (flagged 2026-07-04).** Today a *new device* takes the same path as true recovery: it forces the
  user to re-enter the one-time recovery code (`App.tsx:208` `needsRecoveryCode` → `RecoveryCodeEnter`,
  copy: "This is a new computer. Enter the recovery code…"). The precedent splits these two events: routine
  new-device setup is handled by **device-to-device trust** — an already-signed-in device vouches for the
  new one and passes the key over an encrypted channel (Apple ADP "approve from another device"; 1Password's
  Secret-Key QR / setup code from an existing device) — and the recovery code/kit is reserved for the
  *no-device-left* lockout case only. We have no such handshake, so we push a break-glass action onto an
  everyday event. **Fix = build device-to-device trust**; the recovery code then drops back to lockout-only,
  matching Apple/1Password. This is the *same primitive* as the trusted/recovery-contacts safety net
  (roadmap in `strategy/SPEC.md`) — and Apple's ADP *requires* a second recovery method (recovery contact
  **or** recovery key) before ZK can even be enabled — so one build closes both gaps. Not yet scheduled;
  sits alongside the R2/portability piece in the ZK-hardening line (below).
- New `KeyProvider` impl: **`UserMasterKeyProvider`** — **built** (Phase 3; Argon2id via swift-sodium,
  decided 2026-07-01). Its primitives support BOTH a password path and a recovery-code path (both tested);
  passwordless simply leaves the pw path unused — no rework, the `wrappedMK_pw` slot just stays empty.
- **Cross-device** now genuinely needs the server-side index (the deferred R2/portability piece): the
  wrapped MK + the journal/manifest must be fetchable on a fresh install. ZK makes this load-bearing, not
  optional.

### Billing (Paddle MoR)
- Paddle-hosted checkout + customer portal (no card data touches us). **Webhooks** drive subscription
  lifecycle → our account backend flips `subscription_active`. Uploads are gated on an active sub.
- Retrieval fees: **shipped** (2026-07-13, `RETRIEVAL.md`). The daemon's `getPricing` rate card is DELETED —
  a restore's price has one source, the backend's `POST /retrieval/quote` (quote → pay → thaw, hard-gated at
  IAM: the user role has no `s3:RestoreObject`).

### Account backend (new)
- Minimal API linking **Cognito identity ↔ Paddle subscription ↔ the encrypted key-blob**. Responsibilities:
  (1) serve/store the wrapped-MK key-blob (ZK), (2) receive Paddle webhooks + expose `subscription_active`,
  (3) optionally broker the Cognito identity id. Stateless-ish; smallest thing that works — **decided in
  P4: Hono on Vercel + Neon/Drizzle** (not the originally-sketched Lambda+DynamoDB; see Phase 4).

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
2. **Daemon credential seam — DONE ✅ (2026-07-01, all 3 sub-steps landed).** Built in gated sub-steps.
   ⚠️ **Read the "Superseded 2026-07-13" note at the end of this phase before trusting 2a/2b below** — the
   no-Cognito fallback and the machine-wide journal they describe are both gone.
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
     consumers read them: **`daemon:mac:install`** substitutes 2 new plist placeholders
     (`__COGNITO_IDENTITY_POOL_ID__`/`__COGNITO_USER_POOL_PROVIDER__`) into
     `launchd/com.theadpharm.coldstored.plist.template`, blank when the handoff predates 2c; **`ui:mac:config`**
     writes the same 2 values into the packaged app's `config.json`, read by `ui/src/main/daemon.ts`'s
     `AppConfig`/`daemonEnv` (same pass-through pattern as `bucket`/`region`/`awsProfile`) so the Electron-app
     daemon supervisor picks them up too. `coldstored/main.swift`'s gate now treats an **empty string** the
     same as unset (`nonEmpty(_:)`) — needed because the plist/config.json always set the keys now, blank
     when not configured, instead of omitting them. Verified: `daemon:build:dev` + `daemon:test` (72 green) +
     `ui:typecheck` + `ui:test` (51 green); all 3 new/changed shell blocks passed `bash -n`.

   - **Superseded 2026-07-13 (security refactor).** Two things described above are no longer true.
     (i) The "unset ⇒ default credential chain + flat `blobs`" fallback in 2b is **gone**: `coldstored`
     now requires **exactly one** of Cognito (multi-user) or an explicit `COLDSTORE_DEV_IDENTITY`
     (local dev/MinIO), and refuses to start (`exit 2`) with neither — that fallback signed S3 calls as
     the shared all-access IAM user (`blobs/*`) against a shared key prefix. *(Update 2026-07-14: the
     `COLDSTORE_DEV_IDENTITY` half is gone too, retired with the MinIO sandbox — `coldstored` now requires
     Cognito, full stop. One identity path into the daemon, not two.)* (ii) The per-user state is
     no longer a machine-wide journal: it lives in a `UserSession` at `<COLDSTORE_DATA_DIR>/users/<sub>/`
     (journal + staging + status.json), built at `authenticate` and destroyed at `deauthenticate`, and
     the raw `keyPrefix: String` is now the typed `VaultPrefix`. See CHANGELOG 2026-07-13.

     **Verified (2026-07-13):** 95 Core tests incl. `SessionIsolationTests` (which fails if the fix is
     reverted — mutation-checked); `coldstored` refuses to start with no identity; two dev identities on
     one data root keep fully separate journals on disk. **NOT yet verified:** the real Mac path — a live
     Cognito sign-in as account A, sign-out, sign-in as account B. The tests drive the real
     `DaemonService` but stub the Cognito token exchange (`beginSession`/`endSession`), so the one thing
     unproven is `authenticate` deriving `sub` from a real ID token (`IDToken.sub(of:)`) and keying the
     state dir by it. Ben was running this on his Mac when the session closed — **confirm before trusting
     this phase as closed.** Anyone re-running must `task daemon:mac:reset:local` first: the pre-refactor
     machine-wide `coldstore.sqlite` is now orphaned (it holds *both* accounts' rows — it is the leak).

   Why **atomic** to actually upload as a user: the IAM policy only grants `blobs/<sub>/*`, so the credential
   swap (2b) and the per-user prefix (2a) must both be live or every PUT is `AccessDenied`. All of 2a/2b/2c
   are now live end-to-end (daemon wiring + the handoff that populates it) — what's left is a real Cognito
   user/token to actually exercise the path, which is Phase 5 (app auth UX) or a manually-minted token.
   *Gates:* unit test (a custom prefix round-trips; restore reads the stored key) + build green — **MET**.
   **LIVE gate — MET ✅ (2026-07-02).** Proven for real via the 5a app flow: Ben signed in with Google,
   deposited a file, and it landed at `blobs/<his-identityId>/…` in the production vault. The adversarial
   half is a repeatable task (`task daemon:gate-test`): it mints a throwaway second Cognito user, gets it
   real STS creds, and confirms own-prefix PUT is allowed while cross-prefix PUT AND a GET of Ben's real
   object both return `AccessDenied` — **GATE PASSED**. The per-user boundary holds against a real
   second identity, not just in theory.
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
4. **Account backend — GATE MET ✅ (2026-07-02, staging lane): Paddle-simulator webhook flipped
   `subscriptionActive` in the staging Neon DB, both confirmed by Ben.** Staging is deployed and
   verified live at `https://api-staging.coldstorage.sh` (health + 400-on-unsigned-webhook +
   401-on-tokenless routes smoke-tested). **PRODUCTION LANE LIVE ✅ (2026-07-10)** — the last P4
   piece is done: live Paddle account + catalog (2026-07-09, see `PADDLE.md`), prod Neon DB with
   schema pushed (Ben), a live webhook destination at `https://api.coldstorage.sh/webhooks/paddle`
   (`ntfset_01kx68ekrpz6fzjt9jjr7zy9rf`, same nine `subscription.*` events as staging, created via
   the Paddle API), all 3 prod Vercel secrets real (`DATABASE_URL` 07-01 by Ben; scoped runtime
   `PADDLE_API_KEY` + `PADDLE_WEBHOOK_SECRET` 07-10 — see PADDLE.md "Runtime key scope"), production
   redeployed and smoke-tested from outside (health 200 / unsigned webhook 400 / tokenless 401).
   Residual: a *matching* webhook secret can't be proven from outside (wrong secret also 400s) —
   proven by the first live event's 200 in Paddle's notification log. History below. Stack decided
   with Ben: **Hono on
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
   output` values). Vercel project **created — `coldstorage-account-backend`** (project id
   redacted, verified via the Vercel API to confirm the name matches exactly what the OIDC trust
   condition expects), wired into `live/production/terragrunt.hcl`. **`terragrunt plan` is clean against
   real AWS + Vercel providers for BOTH stacks** (production `9 to add`; staging `10 to add`) — also
   confirmed the account's Vercel OIDC provider and the Vercel-API-token SSM param
   already exist (an open question going in; now resolved). Custom domains DECIDED
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
   non-standard filename like this, hence the explicit flags. **Tried for real 2026-07-02** — Ben ran
   `task link` → `task pull` → `task backend:db:push` on his Mac against the staging Neon branch; the
   whole chain works (this was the step that stood the staging DB up).
   **Infra APPLIED for real (confirmed 2026-07-01 via `terragrunt state list`)** — both stacks are live,
   not just plan-clean: production shows all 9 resources in state (the OIDC role +
   `coldstorage-account-backend-production-vercel`, the 5 TF-managed vars, the 3 manual-secret
   placeholders), staging shows all 10 (same set + the `staging` custom environment); re-plans on both
   come back "No changes." This must have been run directly by Ben — not by me (I don't run `apply`).
   **Staging lane STOOD UP end-to-end (2026-07-02, Ben-executed; the four ex-blockers are done):**
   Neon project created (staging DB; schema pushed via `task link`/`pull`/`backend:db:push` — the
   pull mechanics verified for real); Paddle **sandbox** account live with the product catalog
   (3 tiers × 4 term prices at the NEW no-multi-year-discount pricing — see `strategy/SPEC.md` §5,
   re-decided 2026-07-01: terms are exactly N× the yearly rate, multi-year = rate-lock, not discount),
   a zero-permission API key, and a webhook destination for the nine `subscription.*` events pointed
   at `https://api-staging.coldstorage.sh/webhooks/paddle`; staging's 3 Vercel secrets set for real
   (production's 3 remain `SET_IN_VERCEL_DASHBOARD` placeholders until a LIVE Paddle account + prod
   Neon branch exist — that's the deferred production lane, nothing blocks on it). First `staging`
   push deployed — and crashed twice, same root cause: Vercel's zero-config Hono build transpiles
   per-file (NO bundling), so source must be valid runtime Node ESM — tsconfig `~/*` aliases don't
   exist at runtime, and neither do extensionless relative imports. Fixed for good (`3352384` +
   `55a5769`): relative imports with `.js` extensions + tsconfig on `module`/`moduleResolution`
   `nodenext`, which makes an extensionless relative import a hard `tsc` error — `task
   backend:typecheck` is itself the regression guard (verified: stripping one extension fails TS2307).
   **Staging VERIFIED LIVE (2026-07-02):** Vercel Authentication disabled (endpoints are
   self-securing — Cognito JWT / Paddle HMAC); smoke-tested from outside: `GET /` serves the health
   text, unsigned `POST /webhooks/paddle` → 400 (HMAC guard), tokenless `/entitlement` + `/key-blob`
   → 401. **Gate test PASSED (2026-07-02):** Paddle simulator (`subscription.activated` with
   `custom_data.cognitoSub` edited into the payload — note the simulator only lets you edit AFTER a
   first run: Payload tab → click to edit → Replay) delivered 200 and flipped `subscriptionActive`
   in the staging DB, confirmed by Ben in the Neon console — "webhook flips state" proven with zero
   checkout UI. "Upload blocked when inactive" (the daemon consuming `/entitlement`) rides with
   Phase 5's auth handoff.
5. **App auth + paywall UX — DONE ✅ (steel thread; 5a/5b/5c all gate-PASSED, last 2026-07-03).
   The once-deferred multi-plan paywall is now BUILT (2026-07-10, see 5c addendum below), and the
   daemon-side sign-out command landed the same day (sub-decision closed below).** Passwordless sign-in/up (Google via
   Cognito managed login in the SYSTEM browser — Google blocks embedded webviews — code+PKCE to the
   `coldstorage://` callback; email-OTP codes via `ALLOW_USER_AUTH` as the no-Google path) +
   recovery-code capture + subscribe flow in the Electron UI; token handed to the daemon. Cut
   hardest-first into three gated sub-steps (research pass 2026-07-02 verified every endpoint shape
   against current AWS/Electron/Paddle docs before building):
   - **5a — auth steel thread: BUILT ✅ (2026-07-02; `ui:typecheck` green, 64 ui tests green, TF plan
     surgical). LIVE gate is Ben's (below).** The riskiest slice end-to-end: system browser →
     managed-login PKCE (S256; RFC 7636 vector-tested) → redirect → code exchange → tokens → daemon
     `authenticate`. New `ui/src/main/auth/` (pkce/oauth/loopback/manager/config/ipc): access+ID
     tokens in main-process MEMORY only, refresh token safeStorage-encrypted (Keychain; keytar is
     dead/archived) in `userData/auth.json`, auto-refresh 5 min before the 1-h expiry, every fresh ID
     token (sign-in + refresh + daemon reconnect) re-runs `authenticate` so the daemon's Cognito
     logins never go stale. **Redirects, two lanes:** packaged = `coldstorage://auth/callback` deep
     link (electron-builder `protocols` → CFBundleURLTypes; `open-url` registered pre-ready + buffered
     — a URL can LAUNCH the app); dev = `http://localhost:53682/auth/callback` one-shot 127.0.0.1
     listener, because an UNPACKAGED Electron on macOS physically can't receive custom-scheme links
     (no Info.plist entry — Electron docs are explicit). Duplicate/foreign callbacks dropped by
     `state`-match against the single pending attempt (also the CSRF guard). Renderer: `AuthStatus`
     over IPC (never a token), sign-in gate view + Settings account card; dogfood installs
     (`configured: false`) see zero auth UI, byte-for-byte the old behavior. Infra: callback list +
     `cognito_domain` output (plan verified **0 add / 1 change / 0 destroy**; also pinned the six
     AWS-computed Google `provider_details` keys that were causing perpetual plan drift); handoff →
     `ui:mac:config`/`ui:mac:dev`/`ui:mac:live` now carry `COLDSTORE_COGNITO_DOMAIN`/`_CLIENT_ID` (dev lanes strip
     the daemon secrets). **5a gate — MET ✅ (2026-07-02):** Ben signed in with Google and deposited a
     file that landed under his per-user prefix in the production vault; `task daemon:gate-test` then
     proved the boundary adversarially (own-prefix PUT ok, cross-prefix PUT + GET of Ben's real object
     both `AccessDenied`) — this also closes Phase 2's outstanding LIVE gate. **War story:** sign-in hung
     because VS Code's devcontainer auto-forwarded the dev loopback port (it printed `localhost:53682`
     in a terraform plan) and squatted `127.0.0.1:53682` on the Mac, black-holing the OAuth redirect;
     fixed with `devcontainer.json` `portsAttributes` (`onAutoForward: ignore`) + a fail-loud bind in
     `manager.signIn` (binds the listener BEFORE opening the browser). **Decided alongside:**
     dogfood→multi-user is a clean RESET, not a migration (`task daemon:mac:reset:local + daemon:reset:vault`) — the
     pre-auth archive at `blobs/<hash>` is unreachable from a Cognito identity anyway, so no S3
     re-prefix / journal-rewrite / key-rewrap migration is needed.
   - **5b — email-OTP lane + signup + recovery code + ZK wiring — DONE ✅ (2026-07-02, all three
     sub-steps gate-passed).**
     Re-sliced hardest-first: the ZK vault spine is the load-bearing part, so it goes first and is
     provable through the *existing* Google sign-in; email-OTP is genuinely independent scope (5b-3).
     **Architecture decision (2026-07-02):** all ZK crypto stays in Swift/libsodium (daemon-side); the
     app orchestrates + escrows. The daemon's `keys` is now a `SwappableKeyProvider` (lock-guarded
     `@unchecked Sendable`, shared by BOTH engines by reference — same trick as CognitoAuth's resolver):
     a real (multi-user) session starts LOCKED so `userKEK()` throws `.vaultLocked` and a deposit before
     unlock fails clean — the crypto analogue of the identity pool gating S3; only an explicit local-dev
     daemon (`COLDSTORE_DEV_IDENTITY`) seeds it eagerly from a local file KEK.
     *(Amended 2026-07-13: the key holder now lives on the `UserSession`, not on `DaemonService`, so it
     cannot outlive a sign-out; and there is no implicit "dogfood mode" — see the Phase 2 supersede note.)*
     - **5b-1 — daemon vault core: DONE ✅ (2026-07-02, 83 Core tests green + `ui:typecheck`/66 ui
       tests green).** `SwappableKeyProvider` + `.vaultLocked` (`Crypto.swift`); `mintRecoveryOnly`
       (passwordless — recovery code is the sole lock; password slot is a real wrap under a random
       discarded secret, keeping the KeyBlob shape + the backend's not-null columns intact) +
       `generateRecoveryCode` (25 chars Crockford base32, ~125 bits, `XXXXX-…` grouped)
       (`ZeroKnowledgeKeys.swift`); four control commands gated on `cognitoAuth != nil` — `mintVault`
       (returns blob-to-store + one-time code + MK-to-escrow), `unlockVault {masterKey}` (day-to-day
       from the app's cache), `unlockVaultWithRecoveryCode {keyBlob…, recoveryCode}` (new device,
       returns MK), `lockVault` (sign-out) — all key material over the LOCAL socket only, never the
       network. `main.swift` builds the provider seeded/locked by mode; `protocol.ts` mirrors the DTOs.
       *Gate met:* unit tests — locked provider throws `.vaultLocked`, unlock round-trips a real DEK
       through the exact `EnvelopeCipher`, wrong recovery code fails closed, mint MK == recovery-unlock
       MK, seeded (dogfood) provider never gates.
     - **5b-2 — app vault orchestration + recovery-code UI: DONE ✅ (2026-07-02, `ui:typecheck` +
       72 ui tests green).** New `ui/src/main/vault/` (keyblob-client/storage/manager/config/ipc): the
       `VaultManager` runs after `authenticate` in the daemon handoff and decides per-device — cached MK
       (safeStorage, keyed by `sub`) → `unlockVault` (silent, the day-to-day + reconnect path); no cache
       + 404 key-blob → `mintVault` → PUT the blob + escrow the MK + show the one-time recovery code;
       no cache + existing blob → NEW device → prompt → `unlockVaultWithRecoveryCode`. Backend key-blob
       client maps the `wrappedMk`↔`wrappedMK` casing at the one boundary; base URL defaults to the
       staging lane (accepts production Cognito tokens, so this works end-to-end today). Renderer sees
       only `VaultStatus` over IPC (never key material except the one-time code): reducer/controller
       fold + `views/RecoveryCodeView.tsx` (show-once, enter-code, provisioning/error gates) wired into
       `App.tsx`'s gate. Sign-out relocks the daemon but KEEPS the per-device escrow (`vault.json`,
       re-signin is silent); `task daemon:mac:sim-new-device` deletes just that escrow to force the
       recovery-code path. Tests: `VaultManager` cached/mint/new-device/error/relock branches headless +
       the vault-status fold. **Gate — PASSED ✅ (2026-07-02, Ben, Mac):** fresh Google sign-in → recovery
       code shown once → deposit; then `task daemon:mac:sim-new-device` (deletes the MasterKey escrow, no
       second Mac) → relaunch → sign-in prompted for the recovery code → entered it → the vault unlocked
       and the files were there. The full zero-knowledge spine is proven on real hardware.
       **Fixes found during the gate run (all committed):** (1) the installed launchd daemon predated
       5b-1 — `daemon:mac:install` rebuilds it (obvious in hindsight; ui:mac:live uses the installed binary);
       (2) `unlockVaultWithRecoveryCode` sent the key-blob's numeric `opsLimit`/`memLimit` as JSON
       numbers over the `[String:String]` control wire, so the daemon rejected the command and it looked
       like a wrong code — now sent as strings (like restore's `days`), regression-tested; (3) UX:
       the vault gate screens got a real DS card surface (the DS filled `Field` was invisible on app-bg,
       `--surface-input` ≈ `--bg-app`), full-width Field/Button, an account line ("Signed in as … · Not
       you?") so a wrong-account sign-in is caught before committing, and a `Checking…` startup gate
       (`initializing` + a new auth `restoring` state) so a returning user never flashes past the login
       screen while the saved session refreshes.
     - **5b-3 — email-OTP sign-in + signup lane: DONE ✅ (2026-07-02, `ui:typecheck` + 80 ui tests
       green; live Cognito verified: app client has `ALLOW_USER_AUTH`+`ALLOW_REFRESH_TOKEN_AUTH`, pool
       first-auth factors include `EMAIL_OTP` — no infra change).** App-only (no Swift): new
       `ui/src/main/auth/cognito-idp.ts` speaks the pool's public-client ops as plain HTTPS JSON-RPC
       (`X-Amz-Target`, no SDK/SigV4/secret) — `startEmailSignIn` tries `InitiateAuth USER_AUTH`
       EMAIL_OTP and, on `UserNotFoundException`, falls through to passwordless `SignUp` (so signup and
       sign-in are one email box for the user); `submitEmailCode` answers the challenge (signin) or
       `ConfirmSignUp`→`InitiateAuth`-from-session (signup). The tokens feed the SAME adopt/handoff/vault
       machinery as Google. **Lane-aware token lifecycle** (the load-bearing integration): `TokenSet`
       gains `lane` (`oauth`|`email`), persisted with the refresh token; refresh uses the matching
       endpoint — OAuth at `/oauth2/token`, email at `InitiateAuth REFRESH_TOKEN_AUTH` — on live refresh,
       restore, AND the daemon-reconnect path. UI: the sign-in card gets an "Use an email code instead"
       step machine (email → code), shown only when `auth.emailAvailable` (region resolved from the
       managed-login domain). Tests: cognito-idp request shapes / token mapping / new-user fallthrough /
       wrong-code / refresh-keeps-token (mocked fetch). **Gate (Ben, Mac):** a fresh email signs up with
       one code and lands in the app (mints a vault); an existing email signs in with a code. NOTE: OTP
       emails send via the pool's default Cognito sender (Essentials tier, ~50/day) — fine for dogfood;
       real prod wants SES.
     Verified shapes for 5b-3: `SignUp`
     with NO password is first-class for passwordless pools; `ConfirmSignUp`'s `Session` feeds
     `InitiateAuth USER_AUTH` so signup costs the user exactly ONE emailed code; sign-in =
     `InitiateAuth` + `PREFERRED_CHALLENGE: EMAIL_OTP` → `RespondToAuthChallenge` — all callable as
     plain unauthenticated HTTPS JSON-RPC (`X-Amz-Target`), no AWS SDK in the app.
   - **5c — paywall + subscribe (Paddle): DONE ✅ — steel thread, gate PASSED (built 2026-07-02, backend
     `bun run typecheck`/`bun test` green + `ui:typecheck`/86 ui tests green; gate run 2026-07-03, Ben).** **Scope: single-price proof-of-concept
     for dogfooding.** Real multi-plan picker + pricing page ≠ done (deferred to pre-launch refinement).
     **The hard part (server-side integration) is built correctly:** Backend `POST /checkout-session`
     (requireAuth) creates the Paddle transaction SERVER-SIDE via `@paddle/paddle-node-sdk`
     (`paddle.transactions.create` with `customData: {cognitoSub}` — the only reliable way to carry it; Paddle
     copies it to the subscription so the `subscription.*` webhooks link back) and returns `txn.checkout.url`;
     `PADDLE_PRICE_ID` (non-secret) picks the plan — **TF-managed** per-stack (`paddle_price_id` in
     `infra/account-backend/live/*/terragrunt.hcl`, folded into `tf_managed` only when set, so empty ⇒ no
     env var), and the route errors clearly if it or the default payment link is unset. App: `EntitlementManager`
     (`ui/src/main/entitlement/`) does `GET /entitlement` on every fresh ID token, and `subscribe()` POSTs
     checkout-session → opens the URL in the system browser → polls `/entitlement` until the webhook flips
     active (webhook is the source of truth; a `coldstorage://checkout-complete` deep link is a check-now nudge
     into the same poll). **Deposit gate**: `runDeposit`/`retryDeposit` in `MyFilesView` bail to a
     `SubscribeModal` when `canDeposit` is false — a SOFT gate on NEW deposits only (browse/restore stay open,
     and dogfood + the pre-first-check window are never gated). Settings account card shows subscription state +
     a Subscribe entry. Tests: EntitlementManager refresh/subscribe/error branches (mocked fetch + electron
     shell) + the entitlement fold. **Default-payment-link page BUILT (2026-07-03):** Paddle Billing has
     no Paddle-hosted checkout page — `checkout.url` is literally `<default payment link>?_ptxn=<txn_id>`
     and the checkout renders on OUR page's Paddle.js (verified vs Paddle docs 2026-07-03). New backend
     `GET /checkout` serves it (Paddle.js CDN + `Environment.set` from `PADDLE_ENVIRONMENT` +
     `Initialize({token})`; Paddle.js auto-opens on `_ptxn`). Needs `PADDLE_CLIENT_TOKEN` — a client-side
     token, public by design per Paddle docs, so TF-managed per-stack like the price id
     (`paddle_client_token`). Staging `paddle_price_id` (500 GB / 1-yr sandbox price) + client token are set
     and APPLIED (each plan verified surgical, 1 to add); sandbox **default payment link** set to
     `https://api-staging.coldstorage.sh/checkout`; deployed page smoke-tested from outside (200, Paddle.js
     from CDN, `environment: "sandbox"`).
     **GATE PASSED ✅ (2026-07-03, Ben, Mac, staging lane):** the full loop live — sign in → deposit →
     paywall → Subscribe → our `/checkout` page → Paddle sandbox checkout (card `4242 4242 4242 4242`) →
     `subscription.*` webhook flipped `subscriptionActive` → the app poll saw it → subscription shows
     active in the app. (`4000 0027 6000 3184` = succeeds-then-declines-on-renewal, to test the revoke
     path later.) **War story (first gate attempt failed):** P4's deliberately zero-permission
     PADDLE_API_KEY was fine when the backend only HMAC-verified webhooks, but `transactions.create`
     returns `forbidden: "not authorized to create|read transaction"` with it — surfaced as an opaque
     http-500 in the app, root-caused by reproducing the exact call locally against pulled staging creds.
     Fixed: new sandbox API key with Transactions **read + write**, swapped into the staging
     `PADDLE_API_KEY` in the Vercel dashboard, redeploy. **The production lane's live key must be minted
     with Transactions read+write from day one** (done — the prod runtime key is scoped per PADDLE.md
     "Runtime key scope"). **Multi-plan picker: BUILT + DEPLOYED + INFRA APPLIED ✅ (2026-07-10/11).**
     Backend: new public `GET /catalog` maps live active Paddle products/prices → `{size, years, priceId,
     amountCents, perMonthCents}` (pure `catalog.ts` + unit tests; module-TTL cache in
     `catalog.server.ts`); `POST /checkout-session` now REQUIRES `{priceId}` and 400s any id not in
     that catalog (never trust a client-named price) — `env.PADDLE_PRICE_ID` deleted from the env
     schema and `paddle_price_id` retired from TF. **`terragrunt plan` re-verified clean ("No changes")
     against real state on BOTH stacks (2026-07-11)** — the retirement is applied, not pending. **Both
     `/catalog` endpoints verified live from outside (2026-07-11):** staging and production each return
     real, distinct Paddle price sets (sandbox vs. live price ids), `/subscription` 401s unauthenticated
     as expected. App: `getPlanCatalog()` + `subscribe(priceId)` through manager/IPC/preload;
     `SubscribeModal` renders the spec UX (3 size cards w/ per-year rate, default 1 TB;
     `[1yr][2yr][3yr][5yr]` segmented row, default 1yr; live total + per-month line; "Subscribe to
     <size>"; quiet rate-lock line; catalog-fetch error → retry, no stale list). Old single-price app
     builds break against the new backend by design (all-or-nothing cut, AVOID4). **Still open: Mac-verify
     the actual click-through** — new-customer subscribe via `SubscribeModal` end-to-end to an active sub.
     **Move the default-payment-link page off `api.*` — DONE ✅ (2026-07-11).** The site's branded
     `/checkout` page (`site/app/routes/($lang).checkout.tsx`) is live, verified serving with a real
     production Paddle client token + `environment: "production"`; Ben pointed the LIVE Paddle account's
     default payment link at `https://www.coldstorage.sh/checkout`. Sandbox keeps pointing at staging's
     `/checkout` (`account-backend/src/routes/checkout.ts`, intentionally kept as the staging target).
     **Existing-customer plan changes — BUILT ✅ (2026-07-11, `e686648` + `2969be3`), not yet Mac-verified.**
     Beyond the new-subscriber picker above: `GET/POST /subscription` (backend) + `ChangePlanModal` +
     shared `PlanPicker` (UI) let an already-subscribed customer change plans with a Paddle proration
     preview before committing; `onPaymentFailure: "prevent_change"` so a failed proration charge never
     silently changes the plan, and Paddle errors surface as clean 502s rather than opaque failures. Same-day
     fix: the runtime `PADDLE_API_KEY` needed Subscriptions **read+write**, not just read (mirrors the
     Transactions-scope lesson above). **Open: Mac-verify an existing subscriber actually changing plans**
     end-to-end (preview → confirm → webhook reflects the new plan).
   - **5d — first-run onboarding wizard + display name + terms + survey: BUILT ✅ (2026-07-16; all
     four layers green — TF plan 0/1/0, backend typecheck+45 tests, 134 Core tests, ui:typecheck+149
     tests). NOT yet Mac-verified.** Name (Google-prefilled via new `cognito.tf` `profile` scope +
     `name` mapping — **apply pending, Ben**) → 3-pane tour → recovery code (now a recorded fact,
     with a daemon `reissueRecoveryCode` re-show for the "minted but never confirmed saved" hole) →
     2 skippable survey questions → done. New backend `GET/PATCH /account` + 6 `accountsTable`
     columns (schema-only — **push pending, Ben**: displayName/termsVersion/termsAcceptedAt/
     onboardedAt/recoveryCodeConfirmedAt/survey); terms recorded sign-in-wrap (line on the sign-in
     card → versioned server-side stamp). Resume rules derive from server facts only (no local
     flags); per-account, so existing accounts (Ben's) see the wizard ONCE at next sign-in. Spec:
     `ui/DESIGN.md` §Onboarding; screens signed off via the design artifact 2026-07-16.
     *Gate (Ben, Mac):* fresh email-code signup walks the full 8-step wizard; a Google sign-in
     arrives name-prefilled; quitting mid-wizard resumes at the right step; Settings edits the name.
6. **Sign + notarize + ship — IN PROGRESS.** Developer ID signing + notarization + auto-update + download
   page. *Gate:* a notarized build launches Gatekeeper-clean on a non-dev Mac and self-updates. Scoped
   hardest-first into 6a/6b/6c/6d (2026-07-04; 6d added 2026-07-05):
   - **6a — Developer ID signing + notarization + nested-binary signing + the TCC identity fix:
     SIGNED + NOTARIZED + PUBLISHED ✅ (2026-07-05, Ben's Mac).** `task ui:mac:release` completed clean
     end-to-end: built → Developer-ID-signed → Apple-notarized (all nested binaries + frameworks) →
     published a draft GitHub Release with the `.dmg`/`.zip`/`latest-mac.yml`. `mac.binaries` signs the three
     bundled Swift Mach-Os (`coldstored` + photo-picker + restore) inside-out with the app's Developer ID —
     notarization *rejects* any unsigned nested binary, and TCC keys the Photos grant to `coldstored`'s
     signature. `task ui:mac:release` drives build → sign → notarize → publish, reading creds from the env or the
     gitignored `.env` (APPLE_ID/APPLE_TEAM_ID/APPLE_APP_SPECIFIC_PASSWORD + GH_TOKEN); the yml default stays
     `notarize: false` so plain `task ui:mac:package` still builds unsigned with no cert.
     **War stories getting the first release out (2026-07-05):** (1) electron-builder's production-dep
     collection failed on a stale `node_modules` after the pull (`electron-updater not found`) → the
     packaging tasks now `bun install` first; (2) notary **401** — the `.env` value wasn't a valid
     app-specific password (new **`ui:mac:notarize:doctor`** probes creds against Apple's notarytool directly);
     (3) notarization rejected **every** binary as "not signed with a valid Developer ID certificate" — Ben
     had an *Apple Development* cert, not a *Developer ID Application* one (the only type valid for notarized
     distribution); created the Developer ID cert → clean pass (new **`ui:mac:sign:doctor`** lists identities +
     checks for it). **Remaining to fully close the phase gate (on-Mac, Ben):** (a) **publish the draft**
     v0.1.0 release on GitHub (electron-builder's default `releaseType` is *draft* — the feed isn't live and
     no `v0.1.0` tag exists until it's published); (b) install the `.dmg` + launch **Gatekeeper-clean on a
     NON-dev Mac**; (c) confirm System Settings ▸ Photos now shows **"ColdStorage"** not **"coldstored"** —
     the original screenshot problem (PACKAGING.md lists the fallbacks if a signed child still mis-labels:
     disclaim-responsibility launcher / embedded Info.plist / SMAppService); (d) prove the **self-update
     round trip** (see 6b). Still needs `build/icon.icns` (1024px, from the DS — else the stock Electron
     icon, which is also the Photos-pane icon).
   - **6b — auto-update via GitHub Releases: BUILT ✅ (2026-07-04) + FEED PUBLISHED ✅ (2026-07-05) — the
     self-update *apply* round trip is the last unproven step.** The first signed + notarized build published
     its `.dmg`/`.zip`/`latest-mac.yml` to the GitHub feed (6a), so the feed is real; what's left is to prove
     a running app actually updates itself: install v0.1.0, bump `ui/package.json` → 0.1.1, `task ui:mac:release`
     + publish, and confirm the running app surfaces **"Restart to update"** and relaunches on 0.1.1.
     Decision (Ben, 2026-07-04): **GitHub Releases** as the
     update feed — the repo is public → free, CDN-backed release assets, zero new infra, and it's
     electron-updater's best-supported provider (chosen over S3+CloudFront and serving-from-the-site).
     electron-updater@6 is wired into the packaged main process (`ui/src/main/updater/` — `manager.ts` +
     `ipc.ts`): checks the feed on launch + every 6h, background-downloads a newer *signed* build, folds
     electron-updater's event stream into an `UpdateStatus` pushed to the renderer over the SAME
     manager→ipc→controller→store→reducer seam as auth/vault/entitlement, and a quiet accent-toned top
     banner offers **"Restart to update"** (`quitAndInstall`, whose app-quit cleanly SIGTERMs the supervised
     `coldstored` child via the existing `will-quit`). Dev is inert (a no-op port — auto-update can't run
     unpackaged/unsigned). `electron-builder.yml` gained `publish: github benhonda/coldstorage` + keeps the
     `zip` target (electron-updater applies mac updates from the .zip); version bumped `0.0.0 → 0.1.0`
     (semver is the update comparison). The state machine is unit-tested headless (`manager.test.ts`, fake
     port). **Can't fully prove until 6a signs a build** — macOS refuses to apply an update to an
     unsigned/ad-hoc app. Final update UX (manual "check now", a downloading indicator, banner copy/placement)
     is a UX-session refinement.
   - **6c — download page on `coldstorage.sh` (+ move the Paddle default-payment-link/checkout off `api.*`):
     DEFERRED** to a dedicated session (Ben, 2026-07-04). Cleanly decoupled from 6b — GitHub Releases hosts
     the binaries, so the auto-updater needs no website. Stack not locked; leaning **RR7 on Vercel,
     Terraform-managed** (mirrors the account-backend Vercel/TF pattern + the adpharm stack, grows into
     pricing/account pages, and hosts the moved checkout) over static-on-S3 or folding into the
     account-backend Hono app. The `api.*`→website checkout move (§5c) rides along with this.
     **Update 2026-07-05:** the live site's "Download for Mac" CTAs are now wired — a `/download`
     resource route (`site/app/routes/download.tsx`) 302s to the latest GitHub Releases `.dmg`, so
     the direct-download half of 6c is done. **Update 2026-07-10: 6c is now fully BUILT** — the
     standalone `/download` *page* landed (CTAs → page with install steps + meta-refresh auto-start;
     the 302 resource moved to `/download.dmg`; smoke-tested locally: page renders, resource 302s to
     the real v0.1.0 asset — see `site/SPEC.md`), and the `api.*`→site checkout move shipped earlier
     (`c660c87`, §5c). Remaining 6c-adjacent: Ben pointing the LIVE Paddle default payment link at
     the site's `/checkout` (dashboard-only).
   - **6d — self-configuring customer build — BUILT ✅ (2026-07-05, `ui:typecheck` + 103 ui tests
     green, bake task emits valid JSON verified); PENDING Ben's Mac verify. This is the gate
     between "works for the operator who set it up" and "a stranger can download + use it," so it's
     the true blocker on pointing the live `coldstorage.sh` download button at real customers.**
     Was: the shipped `.dmg` was a **dogfood build** — the daemon's non-secret config (bucket, region,
     Cognito pool ids) reached it *only* via `~/Library/Application Support/ColdStorage/config.json`,
     written by the dev-only `task ui:mac:config`, so a cold customer download launched, showed "connected",
     and had nowhere to store. **Fix (SSOT-driven):** `ui/src/main/config.ts` (new, pure/testable) resolves
     config as **baked base ← user override**. The baked base is `Contents/Resources/app-config.json`,
     written at package time by **`task ui:config:bake`** (wired into `ui:mac:package`/`ui:mac:release`/
     `ui:mac:release:dryrun` before electron-builder bundles it, `electron-builder.yml` extraResources) from the
     **same infra-outputs handoff** as `ui:mac:config` — SSOT-generated, gitignored (`ui/build/app-config.json`),
     PUBLIC values only (bucket/region/Cognito ids/sign-in domain+client/account-API). **`awsProfile` is
     deliberately omitted** — customers get scoped STS creds via Cognito (`coldstored/main.swift`), not a
     local profile. The user's `config.json` still overrides per-key, so dogfood/dev is byte-for-byte
     unchanged; a handoff-less build bakes `{}` (falls back to `config.json`, the old behavior). All three
     config readers (`daemon.ts` env, `auth/config.ts` sign-in, `vault/config.ts` account-API) consume the
     merged result transparently — **net effect: sign-in is the only customer setup.** The customer
     *credential* path itself was already built (`coldstored/main.swift` signs S3 as the signed-in Cognito
     user; Phase 5 gates met). **Remaining (Ben, Mac):** verify a config-less `.dmg` can sign in → subscribe →
     deposit end-to-end. **Two build lanes (`ui:config:bake ENV=production|staging`):** the account-backend
     URL is the ONLY thing that differs between a customer build and a dogfood build (Cognito + the vault
     bucket are shared across lanes — cognito.tf), and the key-blob lives in whichever lane's DB, so the two
     must never cross (onboarding on staging would strand a user's encrypted MK in the test DB). ENV is
     REQUIRED — no silent default — so a customer build can't accidentally ship staging-wired: **`ui:mac:release`
     (+ `ui:mac:release:dryrun`) bake `production` → `api.coldstorage.sh`** (the published customer build);
     **`ui:mac:package` bakes `staging` → `api-staging.coldstorage.sh`** (Ben's local dogfood build — sandbox
     Paddle, never published to the public feed). A working `ui:mac:release` therefore *requires the prod
     account-backend lane to be up first* (Phase 4) — that gate is now MET (prod lane live 2026-07-10, see
     Phase 4). The multi-plan picker is BUILT (2026-07-10, §5c) pending deploy + Mac verify; still deferred
     of the customer-facing last mile: the download page + checkout move (6c above).

## Open sub-decisions (don't block P1; flagged for when their phase lands)
- ~~**Storage quota enforcement** (surfaced 2026-07-10 while building the plan-change flow) — plan
  sizes were SOLD but never ENFORCED.~~ **BUILT ✅ (2026-07-12), soft-gated — matches the existing
  `subscriptionActive` enforcement posture exactly** (hard IAM-layer enforcement remains a separate,
  deliberately deferred piece, same as it always was for the active-subscription check itself).
  **Usage source of truth is S3, not the local journal** — the journal is per-device only and a
  per-device sum would silently undercount (and be trivially defeated) the moment a customer has
  more than one device signed in, which today's architecture doesn't block. Instead: the
  authenticated IAM role gained a scoped `s3:ListBucket` (new `OwnPrefixList` statement,
  `infra/coldstorage/modules/stack/cognito.tf`, condition `s3:prefix` = the caller's own
  `blobs/<sub>/*`, plan-verified surgical — `0 add / 1 change / 0 destroy` — **apply pending, Ben**);
  the daemon's new `S3Store.usageBytes(prefix:)` paginates `ListObjectsV2` under the caller's own
  prefix and sums real ciphertext bytes (60s-cached, keyed by `vaultPrefix` so a re-auth to a
  different identity never serves a stale total) — exposed as `StatusDTO.bytesStored` /
  `Status.bytesStored` (`null` only when signed out). Byte-quota mapping is a new SSOT,
  `account-backend/src/plan-sizes.ts` (`{size, bytes, perYearCents}`), imported by both the Paddle
  seed script and `catalog.ts` — `GET /catalog` now returns `quotaBytes` per plan, throwing loud if a
  live Paddle product's size label isn't recognized (never silently unlimited). `GET /entitlement`
  grows `quotaBytes: number | null`: a new nullable `paddlePriceId` column on `accountsTable`
  (schema-only — **not pushed**, Ben's call same as always) is populated by the existing Paddle
  webhook on every `subscription.*` event, so entitlement can resolve the quota from the
  already-5-min-cached catalog without adding a live Paddle call to the hot path (checked hourly +
  every deposit). App: `canDeposit` (`App.tsx`) gains a `hasCapacity` clause (fails open on any
  unknown value, matching the existing permissive-on-unknown philosophy); over-capacity blocks a
  deposit with distinct, calm copy from the not-subscribed paywall, chaining into `ChangePlanModal` as
  the upgrade path; Settings shows a "plan usage" line once quota is known; `ChangePlanModal` warns
  (non-blocking — a downgrade never deletes data, it only pauses new deposits until back under the
  cap) when the selected plan's quota is below current usage. All four layers verified independently
  green (`daemon:test` 84/84, backend `typecheck`+`test`, `ui:typecheck`+`ui:test` 110/110, TF plan
  surgical) and cross-checked for exact wire-contract consistency. **Remaining: Ben applies the TF
  change, pushes the schema column, and Mac-verifies the actual gate (approach cap → blocked deposit →
  upgrade path clears it).**
  **The gate was silently INERT until 2026-07-13.** `usageBytes` was handed the *un-slashed* prefix
  `blobs/<identityId>`, which does not match the IAM `s3:prefix` condition `blobs/<sub>/*` → every
  usage listing came back `AccessDenied` → `bytesStored` was always `null` in production → `hasCapacity`
  failed open, every time. Fixed by the typed `VaultPrefix` (keys unslashed, listings slashed — the
  slash can no longer be got wrong at a call site). The Mac verify above is still owed, and is now the
  first thing that would actually exercise the gate.
- ~~**Encryption password vs auth credential** — with a federated login there is no password to derive
  KEK_pw from.~~ **DECIDED ✅ (2026-07-02), forced universal by going passwordless:** option (b),
  **recovery-code-only** — the recovery code is the sole MK protector (`wrappedMK_rc`; the `wrappedMK_pw`
  slot goes unused), each signed-in device caches MK in the macOS Keychain (no prompt at launch), a new
  device unwraps with the recovery code, and any signed-in device can reissue a fresh code by re-wrapping.
  See the revised key-hierarchy diagram in §Architecture. Primitives unchanged — `ZeroKnowledgeKeys`
  built both paths; we wire only the rc path in P5.
- ~~**Argon2id library** for Swift (swift-sodium vs a focused Argon2 wrapper) — P3.~~ **DECIDED ✅
  (2026-07-01): swift-sodium.** See Phase 3 above.
- ~~**Account backend shape** (Lambda+APIGW+DynamoDB vs a managed app) — P4.~~ **DECIDED ✅ (2026-07-01):
  Hono on Vercel + Neon/Drizzle.** See Phase 4.
- **Apple Sign-in prerequisites** — Apple Developer Services ID + key (Ben provides) — var-gated off,
  optional post-launch (email-OTP + Google cover sign-in without it).
- ~~**Google IdP prerequisites** — OAuth client, SSM creds, enable flag.~~ **DONE ✅ (2026-07-02): Google
  sign-in is LIVE at the Cognito layer.** OAuth client created (Web application; redirect URI =
  the Cognito domain's `/oauth2/idpresponse`), creds in SSM via `task tf:coldstorage:google-creds`,
  `enable_google_idp = true` applied (Google IdP + hosted-UI domain
  `coldstorage-production-<acct-id>` + OAuth client config). Smoke-tested: `/oauth2/authorize?...
  identity_provider=Google` 302s to accounts.google.com with the full client id. (War story: the first
  apply stored client_id `1000` — the creds task had used `read GID`, and GID is a READONLY built-in
  (the unix group id) in go-task's mvdan/sh; renamed vars + shape guards now prevent that class.)
  The app side (system-browser flow + `coldstorage://auth/callback` handling) landed + gate-passed in 5a.
- ~~**Free trial / plan tiers / retrieval-fee charging** — product/economics (private `strategy/`) — P4.~~
  **DECIDED ✅ (2026-07-12, Ben): no trial — a FREE TIER instead: 25 GB, every account, forever.
  Retrieval is passed through AT COST for everyone, free and paid — the margin is made on storage
  only.** Why a free tier over a trial: this product's value is longevity, which a 14-day window
  can't demonstrate; GDA pricing makes a maxed free account cost ~$0.30/yr; and the quota layer
  (above) already built the enforcement machinery it needs. "Forever" is a promise — the number can
  only ever move UP, hence starting small (25 GB, still above Google's 15 GB free).
  Implementation plan (**DRAFT 2026-07-12**, hardest-first; builds on the quota-enforcement work
  above, so that lands first):
  - **A. Retrieval pass-through — BUILT ✅ (2026-07-13), all four layers green; NOT yet exercised
    end-to-end.** Spec: root `RETRIEVAL.md`; margin model: private `strategy/retrieval-economics.md`
    (verdict: included egress beyond a tiny allowance structurally cannot fit the rate-locked
    margins). **The big find: retrieval could not be soft-gated.** The Cognito user role held
    `s3:RestoreObject`, so any tampered client could thaw + download a whole vault while WE paid the
    egress (~$185 for 2 TB, unrecoverable, possibly from a free user). Unlike the deposit gate, that
    loss is unbounded — so it got a **HARD gate**: `RestoreObject` was removed from the user role and
    granted only to the backend, which thaws only for a paid (or allowance-covered) job. Deep Archive
    can't be read until it's thawed, so this is enforced by IAM, not by asking the client nicely.
    Zero-knowledge is untouched (the backend sees ciphertext metadata only), and no presigned-URL
    machinery was needed — the daemon keeps `GetObject`, which is inert against a frozen object.
    **Applied.** Also fixed: the app was pricing restores from the daemon's rate card (thaw rate only,
    no egress) — **~40× understated** vs what we charge; that local estimate is deleted.
    **Remaining: run one real restore (quote → pay → thaw → download) against Paddle sandbox.** Daemon sizes the restore job; backend prices it at a
    flat ¢/GB that covers GDA restore + egress **+ Paddle's ~5% + $0.50 per-transaction cut** ("at
    cost" must include payment processing or every small restore loses money); Paddle one-time
    transaction; paid webhook unlocks the job. Verify while building: inline custom non-recurring
    prices on `transactions.create`, saved-payment-method checkout for existing subscribers, and
    Paddle's minimum-charge floor. [settled 2026-07-12, Ben] tiny-restore economics: per-job
    checkout for material restores + a small FREE rolling allowance so single-photo/album
    restores cost nothing and need no checkout. A prepaid credit bank was considered and
    deferred (stored-value ledger + balance liability not warranted by bimodal cold-archive
    retrieval; drops in on the same meter later if usage asks). **Allowance size DECIDED
    (2026-07-13, Ben): 1 GB per 30-day window paid, 200 MB free** — as already shipped in
    `retrieval-pricing.ts`; sizing math in `strategy/retrieval-economics.md`. [assumption]
    bulk retrieval tier only at first (48 h, cheapest); standard (12 h) as a priced option later.
  - **B. Free-tier entitlement flip — BUILT ✅ (2026-07-13). NOT yet launched: launch still gates on A
    being exercised end-to-end, since until one real restore has been billed, a free account's
    restores are our cost.** `FREE_TIER_BYTES` (25 GB) is a separate export in `plan-sizes.ts` — same
    SSOT, never a Paddle product (`plan-sizes.test.ts` asserts it has no `PLAN_SIZES` row, so the seed
    script can't sell it, and that it undercuts every paid size, so an upsell always adds room).
    `GET /entitlement` hands it back as `quotaBytes` whenever there's no active subscription, and the
    free path never touches the Paddle catalog (`getCatalog()` throws when Paddle is down — the
    majority path must not depend on a third party). **`active` no longer gates deposits**: the byte
    quota is the single gate for every signed-in account, extracted pure + unit-tested at
    `ui/src/renderer/src/state/entitlement.ts` (a gate that wrongly says "no" is indistinguishable
    from a working paywall — it earned its own tests). `active` survives as a UI signal only, picking
    which upsell a FULL vault shows: a free account picks a plan, a subscriber resizes theirs.
    Fails OPEN on unknown usage/quota, as before. **Testing the cap:** `FREE_TIER_BYTES_OVERRIDE`
    (env, non-TF) shrinks the free tier on a NON-production deployment — 1 GB fills a test vault in
    one upload, so the cap-reached gate + upsell + restore flow are all exercisable without pushing
    25 GB. `resolveFreeTierBytes()` gates it on `PADDLE_ENVIRONMENT`, so production ignores it
    outright: the "forever" promise cannot be shrunk by a config value.
  - **C. Surfaces — app DONE ✅ (2026-07-13), site REMAINING.** In-app: `SubscribeModal` is now
    `reason`-aware ("Your free storage is full" when a free vault blocks a deposit vs. a plain "Choose
    a plan" from Settings), AccountCard + Settings say **"Free"** rather than "No plan", and the
    Storage row reads *"6 GB of 25 GB"* off the same entitlement (no hardcoded cap anywhere in the
    app — it's the backend's number). Remaining: the site pricing section gains the free tier
    (design-synced upstream per `site/SPEC.md`, not hand-edited).
- ~~**Same-email, two sign-in methods = two Cognito accounts.**~~ **DECIDED + BUILT ✅ (2026-07-17,
  Ben): ONE EMAIL = ONE ACCOUNT, linked automatically at the door** — the industry default
  (Clerk/Supabase/Firebase ship it out of the box), keyed on VERIFIED email both sides (Google's
  claim + our OTP; unverified never links — the Auth.js `allowDangerousEmailAccountLinking` lesson).
  New **pre-sign-up Lambda** (`infra/coldstorage/modules/stack/lambda/pre-signup/` — pure
  `decide()` table + thin handler, 10 unit tests; wired by `lambda.tf` + `lambda_config.pre_sign_up`;
  built by `task tf:coldstorage:lambda:build`, a dep of tf plan/apply): a Google first sign-in links
  into the existing native (email-code) user, or mints a passwordless native SHELL user (born
  CONFIRMED — no temp-password dance) and links into that, so the account is native-parented from
  birth and BOTH doors always open the same `sub` → same key-blob → same vault; stale UNCONFIRMED
  native signups are deleted, never linked into (takeover guard). Native signup against a **legacy
  unlinked** Google account (pre-trigger — currently only Ben's) is refused with plain copy ("This
  email signs in with Google — use Continue with Google", unwrapped in `cognito-idp.ts`). The known
  Cognito quirk — the linking sign-in itself fails once with "Already found an entry for username" —
  is auto-retried silently, exactly once, in `auth/manager.ts` (`isFirstLinkError`). Google
  `attribute_mapping` gains `email_verified` (load-bearing for the trigger). **Pending: TF apply
  (plan blocked 2026-07-17 — pharmer SSO token expired; `task login` then
  `tf:coldstorage:plan ENV=production`), then the Mac gate:** ① email-first + Google same address →
  same files; ② Google-first + email-code → same vault; ③ legacy Google account's email-code attempt
  → the clean "use Google" copy. Optional ride-along: retro-link Ben's legacy account by hand so
  both doors work for him too.
- ~~**Daemon-side sign-out** — app sign-out revokes tokens, drops the session, AND relocks the
  vault (5b's `lockVault`, so no crypto happens after sign-out), but the daemon still holds its STS
  creds + `vaultPrefix` until expiry (~1h).~~ **CLOSED ✅ (2026-07-10): `deauthenticate` landed.**
  `CognitoAuth.deauthenticate()` calls `resolver.updateLogins(nil)` — which invalidates the SDK
  resolver's internal credential + identity-id cache (verified against aws-sdk-swift's
  `CognitoAWSCredentialIdentityResolver` source, not assumed) — and nils `vaultPrefix`; with
  `allow_unauthenticated_identities = false` any later S3 call fails clean until the next
  `authenticate`. New `deauthenticate` control command (same no-Cognito gate as `authenticate`);
  the app fires it on every signed-out transition alongside `relock`, daemon-may-be-down tolerant.
  84 core tests + 105 ui tests green. Live signed-in→out flip rides Ben's next on-Mac session.
