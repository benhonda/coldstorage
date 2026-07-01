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
3. **ZK crypto** — `UserMasterKeyProvider` (Argon2id + MK hierarchy) replacing `LocalFileKEK`; recovery
   code; the encrypted key-blob format. *Gate:* unit tests — password change re-wraps MK without touching
   DEKs; recovery code unlocks; round-trip still byte-identical; wrong password fails closed.
4. **Account backend** — Cognito↔Paddle↔key-blob API + webhooks + `subscription_active` gate. *Gate:*
   webhook flips state; upload blocked when inactive.
5. **App auth + paywall UX** — sign-in/up + recovery-code capture + subscribe flow in the Electron UI;
   token handed to the daemon. *Gate:* Ben signs up fresh → subscribes → deposits → restores, on a Mac.
6. **Sign + notarize + ship** — Developer ID signing + notarization + auto-update + download page. *Gate:*
   a notarized build launches Gatekeeper-clean on a non-dev Mac and self-updates.

## Open sub-decisions (don't block P1; flagged for when their phase lands)
- **Encryption password vs auth credential (LOAD-BEARING for P3).** With **Sign in with Apple there is no
  password** to derive KEK_pw from — so the encryption secret that protects the MasterKey **cannot** be the
  login. Options: (a) a *separate* "encryption passphrase" the user sets at signup (one more thing to
  remember, but clean ZK), (b) make the recovery code the *primary* MK protector + escrow a device-local
  copy of MK in the macOS Keychain (smooth per-device UX, recovery code is the cross-device/new-device key),
  (c) email/password users derive from password, Apple users get a generated passphrase. Leaning (b) — it
  matches "remote SSD" muscle memory (no passphrase prompt every launch) while staying ZK. Decide at P3.
- **Argon2id library** for Swift (swift-sodium vs a focused Argon2 wrapper) — P3.
- **Account backend shape** (Lambda+APIGW+DynamoDB vs a managed app) — P4.
- **Apple Sign-in prerequisites** — Apple Developer Services ID + key (Ben provides) — P1 (var-gated; email
  /password works without it).
- **Free trial / plan tiers / retrieval-fee charging** — product/economics (private `strategy/`) — P4.
