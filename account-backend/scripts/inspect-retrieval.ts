/**
 * Eyes on the retrieval hard gate (root `RETRIEVAL.md`) — the one thing you can't see from the app.
 *
 * For each recent restore job it prints what we CHARGED and what S3 actually DID, side by side:
 *
 *   job status   quoted → paid|allowed → (thaw underway) → downloadable
 *   blob state   frozen | thawing | ready
 *
 * That pairing is the whole point. The gate's claim is "a blob is unreadable until a paid job thaws it",
 * and the only honest way to check it is to look at the object in S3, not at our own database. A job that
 * says `paid` while its blobs are still `frozen` means the webhook never fired (or the thaw threw) — the
 * exact failure that would strand a paying customer, and the one thing worth watching on the first run.
 *
 * READ-ONLY. It never thaws, never charges, never writes. Safe to run whenever.
 *
 * Run it via the Taskfile (which loads DATABASE_URL from .env.vercel and your AWS SSO):
 *   task backend:retrieval:jobs                # the 10 most recent jobs, any account
 *   task backend:retrieval:jobs -- --limit 30
 */
import { desc } from "drizzle-orm";
import { HeadObjectCommand, S3ServiceException } from "@aws-sdk/client-s3";
import { db } from "../src/db/index.server.js";
import { retrievalJobsTable } from "../src/db/schema.js";
import { s3 } from "../src/aws.server.js";
import { env } from "../src/env.server.js";

const limitArg = process.argv.indexOf("--limit");
const LIMIT = limitArg >= 0 ? Number(process.argv[limitArg + 1] ?? 10) : 10;

const usd = (cents: number) => (cents === 0 ? "free" : `$${(cents / 100).toFixed(2)}`);
const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(2)} GiB`;

/** What S3 says about a blob RIGHT NOW — the ground truth the gate is supposed to control. */
async function blobState(key: string): Promise<string> {
  try {
    const out = await s3.send(new HeadObjectCommand({ Bucket: env.VAULT_BUCKET_NAME, Key: key }));
    const cls = out.StorageClass ?? "STANDARD";
    const restore = out.Restore; // e.g. ongoing-request="true" | ongoing-request="false", expiry-date="…"
    if (cls !== "DEEP_ARCHIVE" && cls !== "GLACIER") return `ready (${cls} — not archived)`;
    if (!restore) return "❄️  FROZEN (no thaw requested)";
    if (restore.includes('ongoing-request="true"')) return "⏳ THAWING (restore underway)";
    return "✅ READY (thawed — downloadable now)";
  } catch (e) {
    const code = e instanceof S3ServiceException ? e.name : String(e);
    return `⚠️  can't read (${code})`;
  }
}

async function main() {
  console.log("─".repeat(100));
  console.log(`Retrieval jobs — newest first (bucket: ${env.VAULT_BUCKET_NAME}, Paddle: ${env.PADDLE_ENVIRONMENT})`);
  console.log("─".repeat(100));

  const jobs = await db.select().from(retrievalJobsTable).orderBy(desc(retrievalJobsTable.created_at)).limit(LIMIT);
  if (jobs.length === 0) {
    console.log("No restore jobs yet. Request a file back in the app — that creates one.");
    return;
  }

  for (const j of jobs) {
    const authorized = j.status === "paid" || j.status === "allowed";
    console.log(`\n${j.id}  ${j.created_at}`);
    console.log(
      `  status      : ${j.status.toUpperCase()}${authorized ? "  (authorized — the backend may thaw)" : "  (NOT authorized — nothing should be thawing)"}`,
    );
    console.log(`  charged     : ${usd(j.quoteCents)}   (billable ${gb(j.billableBytes)}, free allowance covered ${gb(j.allowanceBytes)})`);
    console.log(`  bytes       : ${gb(j.bytes)} coming back, ${gb(j.thawBytes)} of blobs must be thawed to serve it`);
    console.log(`  paddle txn  : ${j.paddleTransactionId ?? "— (none: free, or not paid yet)"}`);

    for (const key of j.blobKeys) {
      const state = await blobState(key);
      console.log(`  blob        : ${state}`);
      console.log(`                ${key}`);
    }

    // The two failure modes worth shouting about, since neither is visible from the app.
    if (authorized && j.quoteCents > 0 && !j.paddleTransactionId) {
      console.log("  ⚠️  authorized but no Paddle transaction recorded — the webhook may not have landed.");
    }
    if (!authorized) {
      console.log("  ↳ if any blob above is THAWING or READY, the gate leaked: nothing unpaid should thaw.");
    }
  }
  console.log("\n" + "─".repeat(100));
  console.log("A PAID job whose blobs are still FROZEN = the webhook never thawed them (the one that strands a customer).");
  console.log("An UNPAID job whose blobs are THAWING   = the gate leaked (nothing unpaid should ever thaw).");
  console.log("─".repeat(100));
}

main().catch((e) => {
  console.error("\n✗ inspect failed:", e?.message ?? e);
  process.exit(1);
});
