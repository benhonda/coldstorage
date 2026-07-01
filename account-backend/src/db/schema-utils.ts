import { sql } from "drizzle-orm";
import { timestamp } from "drizzle-orm/pg-core";

// NOTE: mode: "string" is required alongside $onUpdate — otherwise Drizzle throws
// "value.toISOString is not a function" (see adpharm-stack references/db.md).
export const timestamps = {
  created_at: timestamp({ withTimezone: true, mode: "string" })
    .default(sql`(now() AT TIME ZONE 'utc'::text)`)
    .notNull(),
  updated_at: timestamp({ withTimezone: true, mode: "string" })
    .default(sql`(now() AT TIME ZONE 'utc'::text)`)
    .notNull()
    .$onUpdate(() => sql`(now() AT TIME ZONE 'utc'::text)`),
};
