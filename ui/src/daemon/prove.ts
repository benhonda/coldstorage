/**
 * Layer-1 proof harness — exercises the IPC bridge against a LIVE daemon (`task daemon:run`).
 * Run it with `task ui:prove` (or `bun run src/daemon/prove.ts`).
 *
 * Proves the contract the design brief asks for:
 *   1. `getStatus` round-trips (typed reply by id).
 *   2. `listFiles` round-trips (the browser's journal-backed tree read).
 *   3. `triggerNow` produces `runStarted` … `runFinished` on the event stream.
 *   4. `getPricing` returns a real rate card (storage + per-tier retrieval).
 *   5. `listExcludes`/`addExclude`/`removeExclude` round-trip (defaults seeded; add then remove).
 * `fileArchived` only fires when there's something new to archive (the pipeline is idempotent), so
 * it's reported when seen but not required — runStarted/runFinished are the reliable invariants.
 *
 * Exit 0 = proven, 1 = failed/timeout. No assertions are faked: every check reads real daemon output.
 */
import { DaemonClient, defaultSocketPath } from "./client.ts";
import type { DaemonEventName } from "./protocol.ts";

const RUN_TIMEOUT_MS = 60_000;

const log = (msg: string) => process.stdout.write(`[prove] ${msg}\n`);
const fail = (msg: string): never => {
  process.stderr.write(`[prove] FAIL: ${msg}\n`);
  process.exit(1);
};

const socketPath = defaultSocketPath();
log(`connecting to ${socketPath}`);

const client = new DaemonClient({ socketPath, autoReconnect: false });

try {
  await client.connect();
} catch (err) {
  fail(`connect failed — is \`task daemon:run\` up? (${(err as Error).message})`);
}
log("connected");

// 1 — ping + getStatus round-trip.
const ack = await client.request("ping");
if (!ack.ok) fail(`ping returned not-ok: ${JSON.stringify(ack)}`);
log("ping → ok");

const status = await client.request("getStatus");
if (typeof status.filesTotal !== "number" || !Array.isArray(status.sources)) {
  fail(`getStatus shape unexpected: ${JSON.stringify(status)}`);
}
log(
  `getStatus → filesTotal=${status.filesTotal} archived=${status.filesArchived} ` +
    `verified=${status.blobsVerified} sources=${status.sources.length} ` +
    `paused=${status.paused} running=${status.running} permFailed=${status.permanentlyFailedBlobs}`,
);

// 2 — listFiles round-trips: the journal-backed browse tree (paths/sizes/status, no S3/no thaw).
const files = await client.request("listFiles");
if (!Array.isArray(files)) fail(`listFiles shape unexpected: ${JSON.stringify(files)}`);
for (const f of files) {
  if (typeof f.id !== "string" || typeof f.relativePath !== "string" || typeof f.size !== "number") {
    fail(`listFiles row malformed: ${JSON.stringify(f)}`);
  }
}
log(`listFiles → ${files.length} file(s)${files[0] ? ` (e.g. ${files[0].relativePath} ${files[0].status})` : ""}`);

// 3 — watch the event stream, then triggerNow; expect runStarted … runFinished.
const seen = new Set<DaemonEventName>();
const runFinished = new Promise<Record<string, string>>((resolve) => {
  client.onAnyEvent((name, data) => {
    seen.add(name);
    log(`event ← ${name} ${JSON.stringify(data)}`);
    if (name === "runFinished") resolve(data as Record<string, string>);
  });
});

const trigAck = await client.request("triggerNow");
if (!trigAck.ok) fail(`triggerNow returned not-ok: ${JSON.stringify(trigAck)}`);
log("triggerNow → ok, awaiting runFinished…");

const timeout = new Promise<never>((_, reject) =>
  setTimeout(() => reject(new Error(`no runFinished within ${RUN_TIMEOUT_MS}ms`)), RUN_TIMEOUT_MS),
);

const finished = await Promise.race([runFinished, timeout]).catch((err: Error) => fail(err.message));

if (!seen.has("runStarted")) fail("runFinished arrived but runStarted was never seen");
log(
  `run complete: archived=${finished.filesArchived}/${finished.filesTotal} ` +
    `blobsFailed=${finished.blobsFailed}` +
    (seen.has("fileArchived") ? " (fileArchived seen)" : " (nothing new to archive)"),
);

// 4 — pricing rate card: real storage + per-tier retrieval numbers (what the UI quotes cost/fee from).
const pricing = await client.request("getPricing");
if (typeof pricing.storageUsdPerGBMonth !== "number" || !Array.isArray(pricing.retrieval)) {
  fail(`getPricing shape unexpected: ${JSON.stringify(pricing)}`);
}
const std = pricing.retrieval.find((t) => t.tier === "standard");
if (!std) {
  fail(`getPricing missing the standard tier: ${JSON.stringify(pricing)}`);
} else if (typeof std.usdPerGB !== "number" || !std.typicalWait) {
  fail(`getPricing standard tier malformed: ${JSON.stringify(std)}`);
} else {
  log(`getPricing → storage=$${pricing.storageUsdPerGBMonth}/GB-mo · standard=$${std.usdPerGB}/GB (${std.typicalWait})`);
}

// 5 — excludes registry: defaults are seeded, and add→list→remove round-trips on the live journal.
const defaults = await client.request("listExcludes");
if (!defaults.includes("node_modules")) fail(`listExcludes missing seeded defaults: ${JSON.stringify(defaults)}`);
const probe = "*.proveprobe";
await client.request("addExclude", { pattern: probe });
if (!(await client.request("listExcludes")).includes(probe)) fail(`addExclude did not persist ${probe}`);
await client.request("removeExclude", { pattern: probe });
if ((await client.request("listExcludes")).includes(probe)) fail(`removeExclude did not drop ${probe}`);
log(`excludes → ${defaults.length} default(s) seeded; add/remove round-trips clean`);

client.close();
log("PASS — bridge round-trips commands and streams events");
process.exit(0);
