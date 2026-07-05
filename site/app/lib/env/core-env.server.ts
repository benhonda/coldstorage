import { z } from "zod";

/**
 * Core server environment — the baseline vars every deployment has.
 *
 * Parsed at import with `.parse()` so a malformed config crashes the process at boot
 * (fail-fast) instead of surfacing as `undefined` mid-request. Add a new service's vars
 * in their own `<service>-env.server.ts` file, not here — the env-map generator
 * consolidates them into `all-server-env.ts`.
 */
const coreEnv = z
  .object({
    /** Node runtime environment — set automatically by the runtime/build tools. */
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    /** Vercel deployment environment (production | preview | development) — set automatically by Vercel. */
    VERCEL_ENV: z.enum(["production", "preview", "development"]).optional(),
  })
  .parse(process.env);

export { coreEnv };
