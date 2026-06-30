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
1. **Infra foundation — DONE ✅ (plan-clean 2026-06-29, PENDING Ben's apply).** Cognito User Pool (+ Apple
   IdP, var-gated off) + Identity Pool + **authenticated IAM role** scoped to
   `blobs/${cognito-identity.amazonaws.com:sub}/*`, in `infra/coldstorage/modules/stack/cognito.tf`
   (+ `variables.tf`/`outputs.tf`). *Gate met:* `terragrunt plan ENV=production` = **6 to add, 0 change, 0
   destroy** (purely additive — doesn't touch the live vault/daemon user), and the policy rendered the
   **literal** `${cognito-identity.amazonaws.com:sub}` variable (the `$${` escape worked). **Ben: apply
   with `task tf:coldstorage:apply ENV=production`, then `creds-export` won't carry the Cognito ids — read
   them from `terragrunt output` (user pool / client / identity pool ids) for Phase 2/5.**
2. **Daemon credential seam — DESIGNED + MAPPED (2026-06-29), implementation is the next pass.** This is
   **atomic** (can't half-ship): the IAM policy only grants `blobs/<sub>/*`, so the credential swap and the
   per-user prefix must land together or every PUT is `AccessDenied`. Verified the SDK is turnkey
   (`CognitoAWSCredentialIdentityResolver` in `AWSSDKIdentity`: `init(identityPoolId:logins:identityPoolRegion:)`,
   actor-isolated `updateLogins(...)` for token refresh, plugs into
   `S3Client.S3ClientConfig(awsCredentialIdentityResolver:region:)`). File-level plan, all sites mapped:
   - **`Package.swift`** — add `AWSSDKIdentity` (resolver) + `AWSCognitoIdentity` (call `GetId` to learn the
     identity id → the prefix; the resolver doesn't expose it).
   - **New `CognitoAuth` actor (Core)** — owns the resolver; `authenticate(idToken)` → `updateLogins` +
     `GetId` → holds `vaultPrefix = "blobs/\(identityId)"`. Unauthed → nil prefix (uploads fail clean).
   - **`coldstored/main.swift:18-20,56-64`** — build the resolver at startup (empty logins), build the
     `S3Client` from it, pass the `CognitoAuth` holder into the run path.
   - **Per-user key as journal SSOT** — `BlobPlan.s3Key` (`Models.swift:35`) + `BlobPlanner`
     (`BlobPlanner.swift:33,37`) take a run-time `keyPrefix`; `performRun` reads the current prefix from
     `CognitoAuth` and passes it to the planner. Journal already stores the full `s3Key` (`Journal.swift:322`);
     **`RestoreEngine.swift:27` must READ it** (new `Journal.blobS3Key(id)` accessor) instead of recomputing
     `"blobs/\(blobId)"` — the keystone correctness change.
   - **Control** — `authenticate idToken=…` command in `DaemonService.handle` (`DaemonService.swift:286`) +
     `ControlServer`; `protocol.ts` typed command + UI bridge (the login UI itself is Phase 5).
   - **Config/handoff** — `tf:coldstorage:creds-export` emits the Cognito ids (user pool / client / identity
     pool / region) into the **gitignored** handoff (public repo — never a tracked file); daemon + app config
     read them.
   *Gates:* unit test (a custom prefix round-trips; restore reads the stored key) + build green; **LIVE gate**
   (real token → own-prefix PUT ok, cross-prefix `AccessDenied`) is Ben's once a test user exists (P5) or via
   a manually-minted token.
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
