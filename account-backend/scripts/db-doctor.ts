/**
 * Does a database match the code?
 *
 * Operates on DATABASE_URL — from `account-backend/.env`, which is loaded last and so overrides
 * `.env.vercel`. That is the one knob: whatever you point .env at is what this inspects. It prints the
 * host first, because "which database am I actually talking to" is the question that bit us — a schema
 * push landed on a branch the deployed API never opens, and the only symptom was a bare `http 500`.
 *
 * The expected shape is DERIVED from the Drizzle table definitions, never hand-listed — a second column
 * list is just a second schema to keep in sync, and it would drift exactly when you need it to be right.
 *
 * NOTE this checks the DB *you* point at. To ask what the DEPLOYED API's database looks like — a different
 * question, and usually the one you want — call its own health endpoint: `task backend:api:health`.
 *
 * Read-only. Fixing a gap is `task backend:db:push`.
 */
import { neon } from "@neondatabase/serverless";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "../src/db/schema.js";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("✗ DATABASE_URL isn't set (expected in account-backend/.env).");
  process.exit(1);
}

const sql = neon(url);
// Every pgTable the schema module exports — derived, never hand-listed, so a future table is
// audited automatically instead of drifting out of this check.
const exported: unknown[] = Object.values(schema);
const TABLES: PgTable[] = exported.filter((v): v is PgTable => is(v, PgTable));

console.log("─".repeat(78));
console.log(`DB doctor — ${new URL(url).host}`);
console.log("─".repeat(78));

let gaps = 0;
for (const table of TABLES) {
  const cfg = getTableConfig(table);
  const rows = (await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${cfg.name}
  `) as { column_name: string }[];

  if (rows.length === 0) {
    gaps++;
    console.log(`✗ TABLE MISSING: ${cfg.name} — every route touching it returns a bare http 500`);
    continue;
  }

  const actual = new Set(rows.map((r) => r.column_name));
  const missing = cfg.columns.map((c) => c.name).filter((n) => !actual.has(n));
  if (missing.length === 0) {
    console.log(`✓ ${cfg.name}`);
  } else {
    gaps++;
    console.log(`✗ ${cfg.name} — missing: ${missing.join(", ")}`);
  }
}

// Contents, because an accounts table holding key-blobs is not a scratch DB whatever the branch is called:
// each blob is the only server-side copy of a user's wrapped MasterKey.
try {
  const rows = (await sql`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE wrapped_mk_recovery IS NOT NULL)::int AS with_keys
    FROM accounts
  `) as { total: number; with_keys: number }[];
  const row = rows[0];
  if (row) {
    console.log(`\ncontents: ${row.total} account(s), ${row.with_keys} with a key-blob`);
    if (row.with_keys > 0) {
      console.log("          ⚠️  irreplaceable — wiping this DB makes those vaults permanently unreadable");
    }
  }
} catch {
  /* accounts table missing — already reported above */
}

console.log("\n" + "─".repeat(78));
console.log(
  gaps === 0
    ? "Schema matches the code."
    : `${gaps} gap(s) — this DB is behind the code. Run \`task backend:db:push\` (it writes; your call).`,
);
console.log("─".repeat(78));
process.exit(gaps === 0 ? 0 : 1);
