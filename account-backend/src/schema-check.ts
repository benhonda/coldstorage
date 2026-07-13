/**
 * Does the DATABASE this service is actually connected to have the schema this CODE expects?
 *
 * The bug this exists for (2026-07-13): a `drizzle-kit push` landed on one Neon branch while the deployed
 * backend read another. Both were "fine". Every route that touched a missing column returned a bare
 * `http 500` with nothing to explain it, and the schema looked correct everywhere you thought to look.
 * The only authority on which database the API opens is the API itself — so it has to be able to say.
 *
 * The expected shape is DERIVED from the Drizzle table definitions (`getTableConfig`), never hand-listed:
 * a hardcoded column list is just a second schema to keep in sync, and it would drift exactly when you
 * most need it to be right.
 */
import { sql } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { db } from "./db/index.server.js";
import { accountsTable, retrievalJobsTable } from "./db/schema.js";

/** Every table the app writes to. Add a table to the schema, and it's checked here automatically. */
const TABLES: PgTable[] = [accountsTable, retrievalJobsTable];

export interface SchemaGap {
  table: string;
  /** True when the table itself is absent (as opposed to just columns). */
  missingTable: boolean;
  /** Columns the code writes/reads that Postgres doesn't have. */
  missingColumns: string[];
}

/**
 * Compare the live database against the Drizzle schema. Returns one entry per table with a problem;
 * an empty array means the DB can serve every query this code can issue.
 */
export async function schemaGaps(): Promise<SchemaGap[]> {
  const gaps: SchemaGap[] = [];

  for (const table of TABLES) {
    const cfg = getTableConfig(table);
    const rows = await db.execute<{ column_name: string }>(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ${cfg.name}
    `);

    const actual = new Set(rows.rows.map((r) => r.column_name));
    if (actual.size === 0) {
      gaps.push({ table: cfg.name, missingTable: true, missingColumns: [] });
      continue;
    }

    // Drizzle's column .name is the DB column name (the snake_case one), which is what we compare.
    const missingColumns = cfg.columns.map((c) => c.name).filter((name) => !actual.has(name));
    if (missingColumns.length > 0) {
      gaps.push({ table: cfg.name, missingTable: false, missingColumns });
    }
  }

  return gaps;
}
