/** Hono `Variables` shared across middleware/routes — keeps `c.get("sub")` typed everywhere. */
export type AppEnv = {
  Variables: {
    /** Cognito User Pool `sub` of the authenticated caller — set by requireAuth. */
    sub: string;
  };
};
