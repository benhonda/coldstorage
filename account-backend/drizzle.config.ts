import { defineConfig } from "drizzle-kit";

// No env.server.ts import here on purpose — drizzle-kit runs standalone (outside the app's
// request lifecycle) and only needs DATABASE_URL, so it reads process.env directly rather
// than pulling in the full validated env schema.
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required to run drizzle-kit");

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: databaseUrl },
});
