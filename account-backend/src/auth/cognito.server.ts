import { CognitoJwtVerifier } from "aws-jwt-verify";
import { env } from "../env.server";

/**
 * Verifies the app's Cognito **ID** token (not the access token) — we need the `sub` claim
 * to key the accounts table. `aws-jwt-verify` derives the region + JWKS URL from
 * userPoolId and caches/rotates keys internally; instantiated once (server singleton).
 */
export const cognitoVerifier = CognitoJwtVerifier.create({
  userPoolId: env.COGNITO_USER_POOL_ID,
  tokenUse: "id",
  clientId: env.COGNITO_USER_POOL_CLIENT_ID,
});

export type CognitoIdTokenPayload = Awaited<ReturnType<typeof cognitoVerifier.verify>>;
