/** Hono `Variables` shared across middleware/routes — keeps `c.get("sub")` typed everywhere. */
export type AppEnv = {
  Variables: {
    /** Cognito User Pool `sub` of the authenticated caller — set by requireAuth. */
    sub: string;
    /**
     * The caller's raw, ALREADY-VERIFIED ID token — set by requireAuth alongside `sub`.
     *
     * Needed because the User Pool `sub` is NOT the identity used in S3 keys: blobs live under
     * `blobs/<identity-POOL id>/…`, and the only way to resolve that id is to hand this token to Cognito
     * Identity's `GetId` (see `identity.server.ts`). Retrieval needs it to prove a blob key belongs to
     * the caller before thawing it at our expense.
     *
     * Exposed ONLY because it has passed `cognitoVerifier.verify()`. Never accept an identity id from a
     * client — derive it from this.
     */
    idToken: string;
  };
};
