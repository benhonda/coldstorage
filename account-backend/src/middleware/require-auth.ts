import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { cognitoVerifier } from "../auth/cognito.server.js";
import type { AppEnv } from "../hono-env.js";

/**
 * Verifies the caller's Cognito ID token (`Authorization: Bearer <idToken>`) and sets
 * `sub` on the request context. Every non-webhook route needs this — the daemon/app is
 * the only caller, authenticated the same way Cognito already authenticates it elsewhere.
 */
export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const header = c.req.header("Authorization");
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
  if (!token) throw new HTTPException(401, { message: "missing Authorization: Bearer <idToken>" });

  const payload = await cognitoVerifier.verify(token).catch(() => undefined);
  if (!payload) throw new HTTPException(401, { message: "invalid or expired token" });

  c.set("sub", payload.sub);
  // The verified token itself — retrieval trades it to Cognito Identity for the caller's identity-pool
  // id, which is what S3 keys are actually prefixed with (see hono-env.ts). Safe to expose: it only
  // reaches the context after `verify()` above has passed.
  c.set("idToken", token);
  await next();
});
