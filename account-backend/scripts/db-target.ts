/**
 * Say out loud which database we're about to operate on — and WHICH LANE that is.
 *
 * `.env` is the source of truth for DATABASE_URL — it's loaded last, so it overrides `.env.vercel`
 * (verified, not assumed). You choose the target there. Nothing rewrites it, guards it, or redirects it.
 *
 * The lane label is DERIVED, never hardcoded: `.env.vercel` is the pulled STAGING baseline (`task
 * pull:account-backend` — production's DATABASE_URL is sensitive and deliberately not pullable), so
 * effective host == baseline host ⇒ staging, and anything else ⇒ not staging (in practice,
 * production). A hardcoded host would drift the moment a branch is recreated; the pulled baseline
 * refreshes on every `task pull`.
 *
 * Why the lane matters enough to shout: staging and production are SEPARATE Neon databases — there
 * is no restore-one-from-the-other here, and `drizzle-kit push` lands on exactly ONE of them. The
 * fact that went unnoticed for an evening was *which host* a push actually hit; the fact that keeps
 * almost going unnoticed is that the OTHER lane still runs its old schema until it gets its own push.
 */
import { readFileSync } from "node:fs";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("✗ DATABASE_URL isn't set (expected in account-backend/.env).");
  process.exit(1);
}
const host = new URL(url).host;

let baselineHost: string | null = null;
try {
  // Runs with cwd = account-backend/ (the task's `dir`). Tolerate `vercel env pull` quoting.
  const line = readFileSync(".env.vercel", "utf8")
    .split("\n")
    .find((l) => l.startsWith("DATABASE_URL="));
  const raw = line
    ?.slice("DATABASE_URL=".length)
    .trim()
    .replace(/^["']|["']$/g, "");
  if (raw) baselineHost = new URL(raw).host;
} catch {
  /* no .env.vercel — reported below */
}

if (baselineHost === null) {
  console.log(`→ database: ${host} — lane UNKNOWN (no .env.vercel baseline to compare against; \`task pull:account-backend\` fetches it)`);
} else if (host === baselineHost) {
  console.log(`→ database: ${host} — STAGING (matches the pulled .env.vercel baseline)`);
} else {
  console.log(`→ database: ${host} — NOT STAGING, presumably PRODUCTION (differs from the pulled staging baseline ${baselineHost})`);
}
