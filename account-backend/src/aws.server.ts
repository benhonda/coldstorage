/**
 * AWS clients for this service (adpharm-stack `references/aws-oidc.md`): credentials resolve BY
 * ENVIRONMENT — Vercel OIDC role assumption in production, an SSO profile locally. No long-lived access
 * keys anywhere; the bridge is the `AWS_ROLE_ARN` that infra hands us.
 *
 * DIVERGENCE FROM THE SKILL, ON PURPOSE (2026-07-27, see /MIGRATION.md): the reference says
 * `fromSSO({ profile: "pharmer" })`, and this file said exactly that until ColdStorage moved off
 * Adpharm's AWS account. A hardcoded profile is now a hardcoded *account*, so local dev would have gone
 * on reading the account we left. `fromSSO()` with no profile honours `AWS_PROFILE`, which the root
 * Taskfile exports from the one place that value lives — so this follows the next account move for free.
 * Don't "restore" the literal because the skill still shows it.
 *
 * This service had no AWS calls at all until 2026-07-13 — the OIDC role existed but was deliberately
 * dormant. What woke it is the retrieval hard gate (root `RETRIEVAL.md`): the backend now holds
 * `s3:RestoreObject`, which the user's own Cognito role deliberately does NOT, and that asymmetry is the
 * entire enforcement mechanism for paid restores.
 *
 * ZERO-KNOWLEDGE IS UNAFFECTED, and must stay that way. This client touches CIPHERTEXT ONLY: it thaws
 * blobs and reads their sizes/metadata. It never downloads object bodies, and it could not read them if
 * it did — the MasterKey never leaves the user's device. Do not add a GetObject-body call here.
 */
import { S3Client } from "@aws-sdk/client-s3";
import { CognitoIdentityClient } from "@aws-sdk/client-cognito-identity";
import { fromSSO } from "@aws-sdk/credential-providers";
import { awsCredentialsProvider } from "@vercel/functions/oidc";
import { env } from "./env.server.js";

const credentials =
  process.env.NODE_ENV === "production"
    ? awsCredentialsProvider({ roleArn: env.AWS_ROLE_ARN })
    : fromSSO(); // profile ← AWS_PROFILE (exported by the Taskfile); see the note above

/** Server singleton (never per-request) — same rule as every other Adpharm AWS client. */
export const s3 = new S3Client({ region: env.AWS_REGION, credentials });

/**
 * Cognito Identity — used ONLY to resolve a caller's identity-pool id from their ID token (see
 * `identity.server.ts`). Note `GetId` is an unsigned API, so this client's credentials are incidental
 * to it; the client exists so the call is typed and retried like any other AWS call.
 */
export const cognitoIdentity = new CognitoIdentityClient({ region: env.AWS_REGION, credentials });
