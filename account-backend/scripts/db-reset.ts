/**
 * Wipe the app database's DATA (schema untouched) so you can test from a clean slate.
 *
 * WHY THIS, AND NOT "RESET STAGING FROM PRODUCTION" (the usual pattern):
 * ColdStorage is zero-knowledge. An `accounts` row's key-blob is a MasterKey wrapped under that user's
 * recovery code — which we do not have and never will. Copying production rows into staging therefore
 * yields accounts you cannot sign into and vaults you cannot decrypt. There is no useful production data
 * to inherit, by design. A clean EMPTY database is the only staging state that's actually testable: sign
 * in, the app finds no key-blob, mints a fresh vault, and you're away.
 *
 * WHAT IT DESTROYS: every key-blob in the target DB. Each one is the ONLY server-side copy of a user's
 * wrapped MasterKey — delete it and any file that user uploaded becomes permanently unreadable, even to
 * them, even with their recovery code (the code unwraps the blob; with no blob there is nothing to
 * unwrap). This is not recoverable. It is not "just test data" unless you are certain it is.
 *
 * Operates on DATABASE_URL — from `account-backend/.env`, which is loaded last and so overrides
 * `.env.vercel`. That is the one knob: whatever you point .env at is what gets wiped. It prints the host
 * and makes you type it back before doing anything.
 *
 *   task backend:db:reset
 */
import { neon } from "@neondatabase/serverless";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("✗ DATABASE_URL isn't set (expected in account-backend/.env).");
  process.exit(1);
}

const target = new URL(url);
const sql = neon(url);

const rows = (await sql`
  SELECT count(*)::int AS total,
         count(*) FILTER (WHERE wrapped_mk_recovery IS NOT NULL)::int AS with_keys
  FROM accounts
`) as { total: number; with_keys: number }[];
const accounts = rows[0]?.total ?? 0;
const keys = rows[0]?.with_keys ?? 0;

console.log("─".repeat(78));
console.log("⚠️  WIPE THE APP DATABASE");
console.log("─".repeat(78));
console.log(`  database : ${target.host}   ← from .env`);
console.log(`  accounts : ${accounts}`);
console.log(`  key-blobs: ${keys}`);
if (keys > 0) {
  console.log("");
  console.log(`  ⚠️  ${keys} key-blob(s) will be DESTROYED. Each is the only server-side copy of a user's`);
  console.log("     wrapped MasterKey. Every file those users uploaded becomes PERMANENTLY unreadable —");
  console.log("     to them too, recovery code or not. There is no undo. Zero-knowledge means we cannot");
  console.log("     rebuild it for anyone, ever.");
}
console.log("");
console.log("  Afterwards: sign in → the app finds no key-blob → mints a FRESH vault. Old S3 blobs under");
console.log("  the old identity are orphaned ciphertext; purge them with `task daemon:reset:vault` and");
console.log("  clear the Mac's journal + escrowed key with `task daemon:mac:reset`.");
console.log("─".repeat(78));

// Confirm by typing the host — the same convention daemon:reset:vault uses (type the bucket name). A
// y/N on something this destructive is too easy to hit on autopilot.
process.stdout.write(`\nType the branch host to confirm (${target.host}): `);
const typed = (await new Promise<string>((r) => process.stdin.once("data", (d) => r(d.toString().trim()))));

if (typed !== target.host) {
  console.log("\nAborted — that didn't match. Nothing was changed.");
  process.exit(1);
}

// TRUNCATE (not DROP): the schema stays exactly as the code expects, so the app boots straight after.
// retrieval_jobs first — it references an account's `sub` conceptually, and truncating it alone is cheap.
await sql`TRUNCATE TABLE retrieval_jobs`;
await sql`TRUNCATE TABLE accounts CASCADE`;

console.log(`\n✅ Wiped. ${target.host} now has 0 accounts, 0 retrieval jobs — schema intact.`);
console.log("   Sign in on the app to mint a fresh vault.");
