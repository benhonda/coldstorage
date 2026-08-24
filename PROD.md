# ColdStorage — going to prod

> The punch list between here and "a stranger downloads it and pays," plus the decisions that got us
> here. **This doc is not a record of what shipped** — `git log` is. If you want the story of how a
> phase was built, read the commits; if you want to know what a thing does, read the code it points at.
> Start at [`README.md`](./README.md) for orientation.

> **"It's only dogfooding" is not a reason to defer anything** [Ben, 2026-07-20]. Judge every fix on
> whether it is correct for a **paid production user** and build it now. "No customers yet", "harden it
> later", "fine for V1" are can-kicking (PILLAR2).

## Decisions in force

Locked with Ben; refine the *how*, don't re-litigate the *what*.

- **Distribution: direct download, Developer ID + notarization** (2026-06-29). Not the Mac App Store —
  its App Sandbox would break the daemon + unix-socket + FSEvents + watch-any-folder architecture, and
  it mandates Apple IAP. We own updates and pricing.
- **Billing: Paddle as Merchant of Record** (2026-06-29). Paddle is the legal seller and carries global
  VAT, chargebacks, invoicing. Ops detail lives in [`PADDLE.md`](./PADDLE.md).
- **Encryption: true zero-knowledge, user-derived keys** (2026-06-29). We cannot read user bytes, which
  *forces* a recovery mechanism — see the hierarchy below.
- **Auth: passwordless** (2026-07-02, revised from email/password). Google IdP is the primary login,
  Cognito native email-OTP is the no-Google path. No passwords anywhere in the product. Apple IdP stays
  var-gated off — direct download means no App Store mandate to offer it.
- **One shared vault bucket, per-user prefix isolation** (2026-06-29). Not per-user buckets, which hit
  account caps. The boundary is the authenticated IAM role scoping every action to
  `blobs/${cognito-identity.amazonaws.com:sub}/*` — AWS substitutes the caller's id at eval time, so
  one user's credentials physically cannot reach another's objects.
- **One email = one account** (2026-07-17), linked at the door by a pre-sign-up Lambda, keyed on
  *verified* email both sides. Both doors open the same `sub` → same key-blob → same vault.
- **No free trial — a free tier instead: 25 GB, every account, forever** (2026-07-12). Longevity is the
  product's value and a 14-day window can't demonstrate it; a maxed free account costs ~$0.30/yr in GDA.
  "Forever" is a promise, so the number can only ever move up — hence starting small.
- **Retrieval is passed through at cost** to free and paid alike (2026-07-12); margin is made on storage
  only. Free rolling allowance: 1 GB per 30-day window paid, 200 MB free (2026-07-13). Mechanism and
  pricing math: [`RETRIEVAL.md`](./RETRIEVAL.md).

## The zero-knowledge key hierarchy

Kept here rather than in a component doc because it spans all three — daemon, backend, and app.

```
recovery code ─Argon2id(salt_rc)─▶ KEK_rc ──▶ unwrap ──▶  MasterKey (MK, random, per-user)
                                                               │
server stores ONLY: wrappedMK_rc + salt                        ├──wraps──▶ per-blob DEKs
(ciphertext; we never see MK or the code)                      ▼
                                          DEK ──▶ AES-256-GCM frames ──▶ S3 (Deep Archive)

each signed-in device: MK cached in the macOS Keychain, so there is no prompt at launch
```

MK *is* the `userKEK()` the envelope crypto already expected, so the engines were unchanged — only what
*produces* the KEK is new (`ZeroKnowledgeKeys.swift`; Argon2id via swift-sodium). A password leg exists
in the primitives but goes unused under passwordless: the recovery code is the sole MK protector.
Lose the code **and** every signed-in device and the data is unrecoverable by design.

**Known gap — new-device onboarding is conflated with lockout recovery.** A new device today takes the
break-glass path and re-enters the one-time recovery code (`ui/src/renderer/src/App.tsx`,
`needsRecoveryCode`). The precedent (Apple ADP, 1Password) splits these: routine new-device setup goes
through **device-to-device trust**, where an already-signed-in device vouches and passes the key over an
encrypted channel, and the recovery code is reserved for the no-device-left case. Fix is to build that
handshake — the same primitive as the trusted-contacts safety net in `strategy/CANON.md`, so one build
closes both. Not scheduled.

## What's left to ship

**Google brand verification.** `auth.coldstorage.sh` serves managed login and clients are on it as of
`v0.1.5`. Google rejected the submission twice on the marketing site, which is why the hero now names
the product (`9db107c`) and `SITE_ORIGIN` points at the host that actually returns 200 rather than the
apex that 308s (`6b06879`). Three steps are Ben's and can't be Terraform's —
`task tf:coldstorage:auth-domain` prints the values and smoke-tests the host:

1. add `https://auth.coldstorage.sh/oauth2/idpresponse` to the OAuth client's redirect URIs;
2. set Branding → authorized domain to `coldstorage.sh` — the registrable domain, *not* the full host,
   which is the standard way to fail verification with an unhelpful error;
3. set app name + logo and submit.

Until it passes, Google keeps showing the domain — but it's now a domain we own, which is most of the
win. Related and unresolved: **who owns the Google Cloud project** holding the OAuth client. If it sits
in Adpharm's Google organisation this isn't fully off Adpharm yet ([`MIGRATION.md`](./MIGRATION.md)).

**One retrieval, all the way through.** The paid path is proven as far as the thaw: on 2026-07-27 a
restore was quoted, paid through sandbox Paddle, and the thaw reached S3 — conclusive because
`s3:RestoreObject` exists *only* on the backend's OIDC role, so the thaw existing at all proves
webhook → Vercel OIDC → AssumeRole → RestoreObject (MIGRATION.md). **The gate is the back half**:
thaw completes → daemon downloads → decrypts → the file lands.

**Free-tier launch** is gated on the line above — until one real restore has been billed end-to-end,
a free account's restores are our cost.

**Live money works — 2026-08-24.** A real card, the live Paddle catalog, from a config-less packaged
`.dmg`: sign in → subscribe → deposit, with the app reflecting the paid entitlement afterwards. That
one run closes three things that nothing short of it could: production's webhook secret genuinely
matches (a wrong one 400s exactly like an unsigned event, so it is unprovable from outside), the live
catalog prices resolve, and a stranger with only the installer can get from nothing to backing up.
**Treat the subscribe path as proven — do not re-flag it as untested.**

**Mac gates owed.** Each of these is exercisable only by a person on a real Mac, doing it the way a
customer would — the layer no test reaches. A gate closes by being done, and the bullet goes:

- an existing subscriber changing plans — preview → confirm → webhook reflects the new plan;
- the quota cap — approach the cap, get the blocked deposit, clear it by upgrading;
- one-email-one-account, all three cases: email-first then Google, Google-first then email, and a
  legacy unlinked Google account getting the clean "use Google" copy;
- the self-update *apply* round trip — a running app surfacing "Restart to update" and relaunching on
  the new version. Publishing a release exercises the feed; only this exercises Squirrel's swap of a
  signed bundle for the running one.

## Known engineering gaps

From the deletion/reclamation audit of 2026-07-20, in severity order:

- **Quota credit is approximate, deliberately.** `Journal.reclaimedCreditBytes` sums plaintext bytes
  against a ciphertext listing and expires on a 7-day window rather than on the object actually leaving
  the listing. Both err the same direction — usage reads high — so a deposit is refused marginally early
  rather than a plan overrun. Real fix: have `S3Store.usageBytes` return key→size and credit only listed
  reaped objects, which also removes the window guess.
- **No test covers `DaemonService.currentUsageBytes`** — where the credit meets the S3 listing, and
  where both imprecisions above actually bite. `ReclaimTests` proves the journal half only.
- **An unrepairable orphan re-logs on every pass.** A `blob_members` row whose file row is gone can
  never satisfy the repair precondition, so it warns forever and reads like a transient fault.
- **`gate-test` assert 4 cascades** — it tags the probe object from assert 1, so a PutObject denial is
  reported as a tagging failure. Its cleanup also uses `aws s3 rm` on a versioned bucket, leaving a
  noncurrent DEEP_ARCHIVE version per run.
- **Residue and multi-device usage both need a server-side index**, not a per-device journal. Scattered
  deletes inside a live folder reclaim less than the full amount (bounded by the 256 MiB blob), and a
  second Mac reads usage high until S3 drops the object. This is the same server-side index the
  cross-device story needs, so ZK makes it load-bearing rather than optional.

Deferred on purpose: **Apple Sign-in** (needs a Developer Services ID + key; Google and email-OTP cover
sign-in without it) and **hard IAM-layer enforcement of the storage quota** — the deposit gate is soft,
matching the subscription check. Retrieval is the exception and is hard-gated at IAM, because that loss
is unbounded: a tampered client could otherwise thaw a whole vault on our egress bill.
