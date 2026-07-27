import { Hono } from "hono";
import { schemaGaps } from "../schema-check.js";
import { env } from "../env.server.js";

/**
 * `GET /health` — can this deployment actually serve requests, and is it wired to what you think?
 *
 * Two questions, both of which can ONLY be answered from in here, and for the same reason: a deployment
 * runs against ITS OWN env vars (set on Vercel), which are not necessarily the ones you are looking at.
 *
 *  1. **Is the database it opens migrated to the schema its code expects?** When it isn't, every route
 *     touching a missing column 500s with no explanation.
 *
 *  2. **Which Cognito pool does it verify tokens against?** (`identity`, below.) Env vars only take
 *     effect on a NEW DEPLOYMENT, so changing them in Terraform or the dashboard leaves the running
 *     instance on the old values until someone redeploys. The failure is brutally unhelpful: a perfectly
 *     valid ID token from the new pool gets a bare **401** from a deployment still holding the old pool
 *     id, and nothing local reveals the mismatch. This bit us for real during the 2026-07-27 AWS account
 *     migration — new pool applied, staging never redeployed, and the app just said "Couldn't set up
 *     encryption". The existing deploy gate could not catch it because the CODE was identical; only the
 *     configuration had moved. So the running service reports its identity and the gate compares.
 *
 * Unauthenticated on purpose: it must be callable by deploy gates and uptime checks, and it leaks nothing
 * (this repo is public — the schema is already in it). It reports column NAMES, never a row of data. The
 * identity ids are public client config too — they ship inside the desktop app (see `cognito.tf`); they
 * identify a pool, they do not grant access to it.
 *
 *   200 { ok: true, identity: {...} }         → the DB can serve every query this code issues
 *   503 { ok: false, gaps: [...], identity }  → migrated DB missing / behind: THIS is your 500
 *   503 { ok: false, error: "...", identity } → couldn't reach the DB at all
 *
 * `identity` is reported in every case, including failures — a misconfigured deployment is exactly when
 * you most need to know which one you are talking to.
 */
const identity = () => ({
  userPoolId: env.COGNITO_USER_POOL_ID,
  identityPoolId: env.COGNITO_IDENTITY_POOL_ID,
  vaultBucket: env.VAULT_BUCKET_NAME,
  paddleEnvironment: env.PADDLE_ENVIRONMENT,
});

export const healthRoute = new Hono().get("/", async (c) => {
  try {
    const gaps = await schemaGaps();
    if (gaps.length === 0) return c.json({ ok: true, identity: identity() });

    return c.json(
      {
        ok: false,
        reason: "the database this deployment reads is behind the code",
        gaps,
        fix: "point account-backend/.env's DATABASE_URL at THIS deployment's database, then `task backend:db:push`",
        identity: identity(),
      },
      503,
    );
  } catch (e) {
    return c.json({ ok: false, error: e instanceof Error ? e.message : String(e), identity: identity() }, 503);
  }
});
