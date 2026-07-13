import { Hono } from "hono";
import { schemaGaps } from "../schema-check.js";

/**
 * `GET /health` — can this deployment actually serve requests?
 *
 * Specifically: is the database it opens migrated to the schema its code expects? That question can ONLY
 * be answered from in here. The database a deployment reads comes from ITS OWN `DATABASE_URL` env var
 * (set on Vercel), which is not necessarily the one you pushed your schema to from your laptop. When those
 * diverge, every route touching a missing column 500s with no explanation, and nothing you can inspect
 * locally reveals it — you have to ask the running service.
 *
 * Unauthenticated on purpose: it must be callable by deploy gates and uptime checks, and it leaks nothing
 * (this repo is public — the schema is already in it). It reports column NAMES, never a row of data.
 *
 *   200 { ok: true }                          → the DB can serve every query this code issues
 *   503 { ok: false, gaps: [...] }            → migrated DB missing / behind: THIS is your 500
 *   503 { ok: false, error: "..." }           → couldn't reach the DB at all
 */
export const healthRoute = new Hono().get("/", async (c) => {
  try {
    const gaps = await schemaGaps();
    if (gaps.length === 0) return c.json({ ok: true });

    return c.json(
      {
        ok: false,
        reason: "the database this deployment reads is behind the code",
        gaps,
        fix: "point account-backend/.env's DATABASE_URL at THIS deployment's database, then `task backend:db:push`",
      },
      503,
    );
  } catch (e) {
    return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 503);
  }
});
