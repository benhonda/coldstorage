/**
 * Say out loud which database we're about to operate on. That's all.
 *
 * `.env` is the source of truth for DATABASE_URL — it's loaded last, so it overrides `.env.vercel`
 * (verified, not assumed). You choose the target there. Nothing rewrites it, guards it, or redirects it.
 *
 * This exists only because the ONE fact that went unnoticed for an evening was *which host* the push
 * actually hit. Printing it costs nothing and makes a wrong-branch push obvious the moment it happens
 * instead of three layers downstream, as a bare `http 500` from a route that looks fine.
 */
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("✗ DATABASE_URL isn't set (expected in account-backend/.env).");
  process.exit(1);
}
console.log(`→ database: ${new URL(url).host}`);
