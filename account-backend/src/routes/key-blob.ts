import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "~/db/index.server";
import { accountsTable } from "~/db/schema";
import { requireAuth } from "~/middleware/require-auth";
import type { AppEnv } from "~/hono-env";

/**
 * Blind storage for the zero-knowledge KeyBlob (see ZeroKnowledgeKeys.swift). Every field
 * here is ciphertext or a KDF parameter — this service never sees a password, recovery
 * code, or MasterKey. Field names match `KeyBlob`'s Swift properties (camelCase over the
 * wire); values are base64 (JSON has no binary type).
 */
const keyBlobSchema = z.object({
  wrappedMkPassword: z.base64(),
  saltPassword: z.base64(),
  wrappedMkRecovery: z.base64(),
  saltRecovery: z.base64(),
  opsLimit: z.number().int().positive(),
  memLimit: z.number().int().positive(),
});

export const keyBlobRoute = new Hono<AppEnv>()
  .use(requireAuth)
  .get("/", async (c) => {
    const sub = c.get("sub");
    const [row] = await db
      .select({
        wrappedMkPassword: accountsTable.wrappedMkPassword,
        saltPassword: accountsTable.saltPassword,
        wrappedMkRecovery: accountsTable.wrappedMkRecovery,
        saltRecovery: accountsTable.saltRecovery,
        opsLimit: accountsTable.opsLimit,
        memLimit: accountsTable.memLimit,
      })
      .from(accountsTable)
      .where(eq(accountsTable.sub, sub))
      .limit(1);

    // No row, or a row created only via the Paddle webhook (subscription before first
    // signup PUT) — either way there's no key-blob yet, so the app should mint one.
    if (!row || row.wrappedMkPassword === null) {
      throw new HTTPException(404, { message: "no key-blob for this account yet" });
    }
    return c.json(row);
  })
  .put("/", async (c) => {
    const sub = c.get("sub");
    const body = keyBlobSchema.parse(await c.req.json());

    await db
      .insert(accountsTable)
      .values({ sub, ...body })
      .onConflictDoUpdate({ target: accountsTable.sub, set: body });

    return c.body(null, 204);
  });
