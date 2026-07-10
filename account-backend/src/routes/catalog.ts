import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { getCatalog } from "../catalog.server.js";
import type { AppEnv } from "../hono-env.js";

/**
 * The sellable plan catalog (PADDLE.md "Multi-plan picker") — the SSOT the app's picker renders.
 * Public by design: these are the same prices the marketing site displays, and serving them live
 * from Paddle (rather than a hardcoded id map) keeps sandbox/production self-consistent with
 * whatever the seed script last wrote.
 */
export const catalogRoute = new Hono<AppEnv>().get("/", async (c) => {
  const plans = await getCatalog().catch((e) => {
    throw new HTTPException(502, { message: `plan catalog unavailable: ${e instanceof Error ? e.message : String(e)}` });
  });
  return c.json({ plans });
});
