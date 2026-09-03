/**
 * Layer-1 proof harness — exercises the IPC bridge against a LIVE daemon (`task daemon:run`).
 * Run it with `task ui:prove` (or `bun run src/daemon/prove.ts`).
 *
 * Proves the contract the design brief asks for:
 *   1. `getStatus` round-trips (typed reply by id).
 *   2. `listFiles` round-trips (the browser's journal-backed tree read).
 *   3. `triggerNow` produces `runStarted` … `runFinished` on the event stream.
 *   5. `listExcludes`/`addExclude`/`removeExclude` round-trip (defaults seeded; add then remove), and
 *      `listExcludeSuggestions` returns the opt-in packs with the shape `protocol.ts` promises.
 *   6. `listRestores` round-trips and every row carries the fields `protocol.ts` promises — the
 *      Transfers page binds straight to these, and `protocol.ts` is a hand-maintained mirror of the
 *      daemon's DTO, so a silent rename is exactly what this catches.
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
if (typeof status.staleAfterSeconds !== "number") {
  fail(`getStatus is missing 'staleAfterSeconds' — protocol.ts and the daemon DTO have drifted`);
}
for (const src of status.sources) {
  // Same whole-shape drift guard as listFiles/listRestores, and it matters here for the nullable pair:
  // a watched folder's scan clock + fault are how the app knows a backup has stopped.
  for (const k of ["id", "kind", "path", "mountPath", "paused", "lastScanAt", "error"]) {
    if (!(k in src)) fail(`getStatus source is missing '${k}' — protocol.ts and the daemon DTO have drifted`);
  }
}
log(
  `getStatus → filesTotal=${status.filesTotal} archived=${status.filesArchived} ` +
    `verified=${status.blobsVerified} sources=${status.sources.length} ` +
    `running=${status.running} permFailed=${status.permanentlyFailedBlobs}`,
);

// 2 — listFiles round-trips: the journal-backed browse tree (paths/sizes/status, no S3/no thaw).
const listed = await client.request("listFiles");
// `revision` is the app's reconciliation clock (see `ListedFiles`) — its absence would silently leave every
// optimistic edit held forever, so it is proven here, not assumed.
if (typeof listed.revision !== "number" || !Array.isArray(listed.files)) fail(`listFiles shape unexpected: ${JSON.stringify(listed)}`);
const files = listed.files;
for (const f of files) {
  if (typeof f.id !== "string" || typeof f.relativePath !== "string" || typeof f.size !== "number") {
    fail(`listFiles row malformed: ${JSON.stringify(f)}`);
  }
  // Whole-shape check, same as the transfers one below and for the same reason: `protocol.ts` is a
  // hand-maintained mirror of the Swift DTO. It matters most for the NULLABLE fields — Swift's synthesized
  // encoder would omit a nil entirely while `ListedFile` declares `T | null`, so a key that quietly stops
  // being emitted is exactly the drift nothing else would notice.
  for (const k of ["status", "blobId", "date", "lastAttemptAt", "error"]) {
    if (!(k in f)) fail(`listFiles row is missing '${k}' — protocol.ts and the daemon DTO have drifted`);
  }
}
log(`listFiles → ${files.length} file(s) at revision ${listed.revision}${files[0] ? ` (e.g. ${files[0].relativePath} ${files[0].status})` : ""}`);

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

// (There used to be a `getPricing` check here. The daemon's rate card was deleted on 2026-07-13 — it
// quoted AWS thaw rates with no egress, and the app was pricing restores from it ~40× under. A restore's
// price now comes only from the account backend. See ColdStorageCore/Models.swift.)

// 5 — excludes registry: defaults are seeded, and add→list→remove round-trips on the live journal.
const defaults = await client.request("listExcludes");
if (!defaults.includes("node_modules")) fail(`listExcludes missing seeded defaults: ${JSON.stringify(defaults)}`);
const probe = "*.proveprobe";
await client.request("addExclude", { pattern: probe });
if (!(await client.request("listExcludes")).includes(probe)) fail(`addExclude did not persist ${probe}`);
await client.request("removeExclude", { pattern: probe });
if ((await client.request("listExcludes")).includes(probe)) fail(`removeExclude did not drop ${probe}`);
log(`excludes → ${defaults.length} default(s) seeded; add/remove round-trips clean`);

// 5b — the suggestion catalogue. Both surfaces that offer packs (Settings' shelf, the drop-time prompt)
// bind straight to these fields, and `protocol.ts` mirrors the Swift DTO by hand — a silent rename here
// would leave the shelf rendering blank rows with no error anywhere.
const packs = await client.request("listExcludeSuggestions");
if (packs.length === 0) fail("listExcludeSuggestions returned no packs");
for (const pack of packs) {
  for (const k of ["id", "title", "detail", "patterns"] as const) {
    if (pack[k] === undefined) fail(`listExcludeSuggestions row missing '${k}': ${JSON.stringify(pack)}`);
  }
  if (pack.patterns.length === 0) fail(`suggestion '${pack.id}' has no patterns`);
  // A suggested pattern that's ALREADY a shipped default can never be offered, and would strand its pack
  // permanently half-on in the UI with no way for the user to complete it.
  const seeded = pack.patterns.filter((x) => defaults.includes(x));
  if (seeded.length > 0) fail(`suggestion '${pack.id}' overlaps the seeded defaults: ${seeded.join(", ")}`);
}
log(`exclude suggestions → ${packs.length} pack(s): ${packs.map((p) => p.id).join(", ")}`);

// 6 — transfers: the list reads (usually empty on a fresh daemon, which is a valid answer), and any row
// present has the whole shape. Checked against the LIVE daemon because `protocol.ts` mirrors the Swift DTO
// by hand — nothing else would notice the two drifting apart.
const transfers = await client.request("listRestores");
for (const t of transfers) {
  for (const k of ["id", "fileId", "relativePath", "out", "state", "tier", "bytes", "requestedAt",
                   "readyAt", "lastStepAt", "completedAt", "error", "typicalWait", "typicalWaitSeconds",
                   "freeUntil", "resumable", "staleAfterSeconds"]) {
    if (!(k in t)) fail(`listRestores row is missing '${k}' — protocol.ts and the daemon DTO have drifted`);
  }
}
log(`transfers → ${transfers.length} recorded; row shape matches protocol.ts`);

client.close();
log("PASS — bridge round-trips commands and streams events");
process.exit(0);
