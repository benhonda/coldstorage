/**
 * Resolve a caller's Cognito **Identity Pool** id — the thing S3 keys are actually prefixed with
 * (`blobs/<identityId>/<blobId>`), and which this service has never needed until now.
 *
 * Why it's needed (root `RETRIEVAL.md`): the retrieval hard gate makes the backend thaw blobs on the
 * user's behalf, at our expense. So before thawing anything, we must prove the requested blob keys
 * actually belong to the caller. That proof is a prefix check — and the prefix is the identity id, NOT
 * the User Pool `sub` this service keys accounts on. The two are different identifiers for the same
 * human (see `db/schema.ts`), and nothing in the ID token carries the identity id.
 *
 * NEVER take an identity id from the client. A caller who could name their own prefix could name someone
 * else's, and we would happily thaw a stranger's archive and pay for it — a griefing vector that costs us
 * real money (they still couldn't READ it; S3 scopes GetObject to the caller's own prefix). So we derive
 * it from the verified ID token via Cognito's `GetId`, which is authoritative by construction: Cognito
 * hands back the identity that token maps to, and no other.
 *
 * Cached on the account row after the first call — the mapping is stable for the life of the identity, so
 * this costs one AWS round trip per user, ever, rather than one per restore.
 */
import { GetIdCommand } from "@aws-sdk/client-cognito-identity";
import { eq } from "drizzle-orm";
import { cognitoIdentity } from "./aws.server.js";
import { db } from "./db/index.server.js";
import { accountsTable } from "./db/schema.js";
import { env } from "./env.server.js";

/** The `Logins` map key Cognito expects for a User Pool token: `cognito-idp.<region>.amazonaws.com/<poolId>`. */
const loginsProvider = `cognito-idp.${env.AWS_REGION}.amazonaws.com/${env.COGNITO_USER_POOL_ID}`;

/**
 * The caller's identity-pool id, from cache or from Cognito.
 *
 * `sub` identifies WHICH account row to cache against; `idToken` is what actually proves the identity —
 * it must already have passed `requireAuth`'s verification before it gets here.
 */
export async function identityIdFor(sub: string, idToken: string): Promise<string> {
  const [row] = await db
    .select({ cognitoIdentityId: accountsTable.cognitoIdentityId })
    .from(accountsTable)
    .where(eq(accountsTable.sub, sub))
    .limit(1);
  if (row?.cognitoIdentityId) return row.cognitoIdentityId;

  const out = await cognitoIdentity.send(
    new GetIdCommand({
      IdentityPoolId: env.COGNITO_IDENTITY_POOL_ID,
      Logins: { [loginsProvider]: idToken },
    }),
  );
  const identityId = out.IdentityId;
  if (!identityId) throw new Error(`Cognito GetId returned no IdentityId for sub ${sub}`);

  // Upsert rather than update: a user can reach a restore before ever completing the key-blob PUT that
  // creates their row (a fresh install signing in to an existing vault, say).
  await db
    .insert(accountsTable)
    .values({ sub, cognitoIdentityId: identityId })
    .onConflictDoUpdate({ target: accountsTable.sub, set: { cognitoIdentityId: identityId } });

  return identityId;
}

/**
 * The S3 key prefix this identity's blobs live under. Single source of the layout, mirrored from
 * `infra/coldstorage/modules/stack/cognito.tf` (the IAM policy that enforces the same boundary) and the
 * daemon's `CognitoAuth.vaultPrefix`. If this string ever drifts from those, the ownership check below
 * silently starts guarding the wrong thing — so there is exactly one place to change it.
 */
export const vaultPrefixFor = (identityId: string) => `blobs/${identityId}/`;

/**
 * Reject any blob key that isn't under the caller's own prefix.
 *
 * Belt-and-braces against path tricks: an exact prefix match plus a `..` ban. S3 keys are opaque strings,
 * not paths, so `..` has no traversal meaning to S3 — but our own prefix arithmetic is the thing being
 * defended here, and a key containing `..` is never one we wrote.
 */
export function assertOwnedKeys(keys: string[], identityId: string): void {
  const prefix = vaultPrefixFor(identityId);
  for (const key of keys) {
    if (!key.startsWith(prefix) || key.includes("..")) {
      throw new Error(`blob key "${key}" is not in this account's vault`);
    }
  }
}
