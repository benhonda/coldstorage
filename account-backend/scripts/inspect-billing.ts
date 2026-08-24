/**
 * Eyes on what Paddle ACTUALLY holds for an account's billing — the view behind the app's
 * "Plan & billing" card, printed from the same key the deployed API runs with.
 *
 * It exists because the panel can only render what `GET /subscription` returns, and when that says
 * something surprising ("No card saved" under a live subscription) there is no way to tell from the
 * app whether the card is missing, unlisted, or unreadable. This prints the three sources side by
 * side so the answer is visible rather than inferred:
 *
 *   DB          what our webhook recorded (ids + the active flag)
 *   subscription  status, plan, next bill  — `subscriptions.get`
 *   saved cards   what `paymentMethods.list` returns for the customer — what the panel shows
 *   payments      what actually CHARGED, per transaction — `transactions.list` → `payments[]`
 *
 * The last two are the pairing that matters. A transaction with a `storedPaymentMethodId` whose id
 * is absent from the saved list means the card is real and simply not listed under that customer —
 * a different bug from "the customer never saved one", and they look identical in the app.
 *
 * READ-ONLY. It never charges, never updates a subscription, never deletes a method.
 *
 * `ENV=staging|production` picks the lane; the key's prefix is asserted against it, so a staging pull
 * aimed at production fails loudly rather than reading the wrong account's money.
 *
 *   task backend:billing:inspect                                        # every subscribed account
 *   task backend:billing:inspect -- --sub <cognito-sub>                 # just one of them
 *   task backend:billing:inspect ENV=production -- --list               # ask Paddle, no DB at all
 *   task backend:billing:inspect ENV=production -- --subscription sub_… # customer derived from it
 *
 * The last two need no database, which is what makes them work on production: only STAGING's env is
 * pullable (see `pull:account-backend` — production's secrets are sensitive by design), so there is
 * no local production DATABASE_URL and never should be. Supply that lane's PADDLE_API_KEY by
 * exporting it; Bun's --env-file does not override an already-set variable, so your shell wins.
 */
import { isNotNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/neon-http";
import { neon } from "@neondatabase/serverless";
import { Paddle, Environment } from "@paddle/paddle-node-sdk";
import { accountsTable } from "../src/db/schema.js";

/**
 * Built from `process.env` rather than `src/env.server.ts`: that module validates the whole API's
 * runtime contract (bucket, identity pool, webhook secret …), and a read-only script needs two vars,
 * not all of them. Same reason `_paddle.ts` builds its own client for the ops scripts.
 *
 * The values come from `.env.vercel` (see the Taskfile), so this runs against the SAME database and
 * the SAME Paddle key as the deployed API — which is the whole point: a key-scope gap has to show up
 * here too, or the script would be reassuring about a lane nobody uses.
 */
const required = (name: string): string => {
  const v = process.env[name];
  if (!v) {
    console.error(`✗ ${name} is missing. Run this via \`task backend:billing:inspect\` (it loads .env.vercel).`);
    process.exit(1);
  }
  return v;
};

// Read RAW, don't silently default. `env.server.ts` gives PADDLE_ENVIRONMENT a `.default("sandbox")`,
// so an UNSET var and a deliberate "sandbox" are indistinguishable downstream — and this script's whole
// job is telling apart states that look identical. Report which one it actually is.
const rawPaddleEnv = process.env.PADDLE_ENVIRONMENT ?? "(unset — env.server.ts would default this to sandbox)";
const paddleEnvName = process.env.PADDLE_ENVIRONMENT === "production" ? "production" : "sandbox";
const paddleKey = required("PADDLE_API_KEY");
const expectedPrefix = paddleEnvName === "production" ? "pdl_live_" : "pdl_sdbx_";
if (!paddleKey.startsWith(expectedPrefix)) {
  // A key prefix is not a secret, and naming BOTH sides is the difference between "something's wrong"
  // and a diagnosis: a live key against Paddle's sandbox host (or the reverse) fails every call with
  // a permission error, which reads exactly like a missing scope and isn't one.
  const got = paddleKey.slice(0, 9);
  console.error(
    `✗ lane mismatch: PADDLE_ENVIRONMENT=${rawPaddleEnv} but PADDLE_API_KEY starts with "${got}" (expected "${expectedPrefix}").\n` +
      `  Either .env.vercel was pulled from the other lane, or an exported PADDLE_API_KEY in your shell is\n` +
      `  shadowing it — Bun's --env-file does not override a variable already set in the environment.`,
  );
  process.exit(1);
}

const paddle = new Paddle(paddleKey, {
  environment: paddleEnvName === "production" ? Environment.production : Environment.sandbox,
});

/**
 * Strict on purpose. A typo'd flag used to parse as "no flags given", which silently selected the
 * DATABASE path — so `--subscription-id sub_x` read the staging DB against production Paddle and
 * printed "not found" for every row. A diagnostic that answers a question you didn't ask is worse
 * than one that refuses: an unrecognised argument is an error here, never a shrug.
 */
const VALUE_FLAGS = ["sub", "subscription", "customer"] as const;
const BOOL_FLAGS = ["list"] as const;

const parseArgs = (argv: string[]): Record<string, string | true> => {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    const [name, inline] = token.startsWith("--") ? splitFlag(token.slice(2)) : [null, null];
    if (name === null) {
      fail(`unexpected argument "${token}" — every argument is a --flag.`);
    } else if ((BOOL_FLAGS as readonly string[]).includes(name)) {
      out[name] = true;
    } else if ((VALUE_FLAGS as readonly string[]).includes(name)) {
      const value = inline ?? argv[++i];
      if (!value) fail(`--${name} needs a value.`);
      out[name] = value!;
    } else {
      fail(`unknown flag "--${name}".`);
    }
  }
  return out;
};

function splitFlag(rest: string): [string, string | null] {
  const eq = rest.indexOf("=");
  return eq === -1 ? [rest, null] : [rest.slice(0, eq), rest.slice(eq + 1)];
}

function fail(why: string): never {
  console.error(
    `✗ ${why}\n  Valid flags: ${VALUE_FLAGS.map((f) => `--${f} <value>`).join(", ")}, --list\n` +
      `  e.g.  task backend:billing:inspect ENV=production -- --subscription sub_…`,
  );
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
const subArg = typeof args.sub === "string" ? args.sub : null;
const subscriptionArg = typeof args.subscription === "string" ? args.subscription : null;
const customerArg = typeof args.customer === "string" ? args.customer : null;
const listOnly = args.list === true;

/**
 * The lane switch moves the PADDLE key; DATABASE_URL always comes from .env.vercel, which is always
 * STAGING's (production's is sensitive and deliberately not pullable). So the DB path is a
 * staging-only path — pairing it with production Paddle looks up staging's ids in the live account
 * and reports every one of them missing, which reads exactly like real data loss and isn't.
 */
if (paddleEnvName === "production" && !listOnly && !subscriptionArg) {
  console.error(
    `✗ the database path is staging-only: DATABASE_URL comes from .env.vercel, which holds STAGING's\n` +
      `  values by design — looking its ids up in the live Paddle account reports them all missing.\n` +
      `  On production, ask Paddle directly:\n` +
      `    task backend:billing:inspect ENV=production -- --list\n` +
      `    task backend:billing:inspect ENV=production -- --subscription <id from --list>`,
  );
  process.exit(1);
}

const money = (minorUnits: string, currency: string) => `${(Number(minorUnits) / 100).toFixed(2)} ${currency}`;
const day = (iso: string | null) => iso?.slice(0, 10) ?? "—";

/** Anything Paddle refuses (a key-scope gap is the usual cause) is printed, not thrown — one dead
 *  section shouldn't hide the three that would have told you why. */
async function attempt<T>(what: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    const detail = (e as { detail?: string }).detail ?? (e instanceof Error ? e.message : String(e));
    console.log(`  ✗ ${what}: ${detail}`);
    return null;
  }
}

async function inspect(row: { sub: string; subscriptionActive: boolean | null; customerId: string; subscriptionId: string }) {
  console.log(`\n${"─".repeat(100)}`);
  console.log(`account ${row.sub}`);
  console.log(
    row.subscriptionActive === null
      ? `  DB          (skipped)  customer=${row.customerId}  subscription=${row.subscriptionId}`
      : `  DB          subscription_active=${row.subscriptionActive}  customer=${row.customerId}  subscription=${row.subscriptionId}`,
  );

  const sub = await attempt("reading the subscription", () => paddle.subscriptions.get(row.subscriptionId));
  if (sub) {
    const item = sub.items[0];
    console.log(
      `  SUBSCRIPTION  ${sub.status}  price=${item?.price.id ?? "—"}  next=${day(sub.nextBilledAt)}` +
        `  collection=${sub.collectionMode}  address=${sub.addressId}` +
        (sub.scheduledChange ? `  scheduled=${sub.scheduledChange.action}@${day(sub.scheduledChange.effectiveAt)}` : ""),
    );
    // The customer the SUBSCRIPTION belongs to, versus the one our DB says to look up cards for.
    // A mismatch is the whole bug when it happens, and silent everywhere else.
    if (sub.customerId !== row.customerId) {
      console.log(`  ⚠️  MISMATCH   the subscription belongs to customer ${sub.customerId}, not the DB's ${row.customerId}`);
    }
  }

  // Exactly what the billing panel reads (`savedPaymentMethod` in routes/subscription.ts) — except
  // this walks EVERY page, so "the panel shows none" and "there are none" stay distinguishable.
  const saved: { id: string; line: string }[] = [];
  await attempt("listing saved payment methods", async () => {
    for await (const pm of paddle.paymentMethods.list(row.customerId)) {
      const card = pm.card ? `${pm.card.type} ••••${pm.card.last4} exp ${pm.card.expiryMonth}/${pm.card.expiryYear}` : pm.type;
      saved.push({ id: pm.id, line: `${pm.id}  ${card}  origin=${pm.origin}  saved=${day(pm.savedAt)}  address=${pm.addressId}` });
    }
    return saved;
  });
  console.log(`  SAVED CARDS   ${saved.length === 0 ? "(none — this is what renders as “No card saved”)" : ""}`);
  for (const s of saved) console.log(`                ${s.line}`);

  const txs = await attempt("listing transactions", () =>
    // Newest first, and the same raw `billed_at` field the route orders on — so this script exercises
    // that query rather than a lookalike, and a wrong field name fails HERE first.
    paddle.transactions.list({ subscriptionId: [row.subscriptionId], orderBy: "billed_at[DESC]", perPage: 10 }).next(),
  );
  console.log("  PAYMENTS");
  if (!txs?.length) console.log("                (no transactions on this subscription)");
  for (const tx of txs ?? []) {
    const totals = tx.details?.totals;
    console.log(
      `                ${tx.id}  ${tx.status}  ${totals ? money(totals.grandTotal, totals.currencyCode) : "—"}  billed=${day(tx.billedAt)}  origin=${tx.origin}`,
    );
    for (const p of tx.payments) {
      const card = p.methodDetails?.card;
      const desc = card ? `${card.type} ••••${card.last4} exp ${card.expiryMonth}/${card.expiryYear}` : (p.methodDetails?.type ?? "—");
      // `storedPaymentMethodId` is the link between "what charged" and "what's saved". If it names an
      // id the list above doesn't contain, the card exists and the list is simply not showing it.
      const stored = p.storedPaymentMethodId;
      const listed = stored ? (saved.some((s) => s.id === stored) ? "listed above" : "NOT in the saved list") : "no stored id";
      console.log(`                  └ ${p.status}  ${desc}  stored=${stored ?? "—"} (${listed})`);
    }
  }
}

/**
 * Ask Paddle what subscriptions exist on this lane. The way in when there is no local database for
 * the lane you care about (production) and no id to hand — which is every first look at a live bug.
 */
if (listOnly) {
  const page = await paddle.subscriptions.list({ perPage: 50 }).next();
  console.log(`${page.length} subscription(s) on this lane:\n`);
  for (const s of page) {
    console.log(`  ${s.id}  ${s.status.padEnd(9)}  customer=${s.customerId}  price=${s.items[0]?.price.id ?? "—"}  next=${day(s.nextBilledAt)}`);
  }
  console.log(`\nInspect one:  task backend:billing:inspect -- --subscription <id>`);
  process.exit(0);
}

/** The DB is only consulted for the lookup path — `--subscription/--customer` deliberately needs no
 *  database, which is what makes it usable against production from a laptop. */
const rows = subscriptionArg
  ? []
  : await drizzle({ client: neon(required("DATABASE_URL")) })
  .select({
    sub: accountsTable.sub,
    subscriptionActive: accountsTable.subscriptionActive,
    paddleCustomerId: accountsTable.paddleCustomerId,
    paddleSubscriptionId: accountsTable.paddleSubscriptionId,
  })
  .from(accountsTable)
  .where(isNotNull(accountsTable.paddleSubscriptionId));

const targets =
  subscriptionArg
    ? [
        {
          sub: "(not looked up — id given directly)",
          subscriptionActive: null,
          // Paddle's own answer beats a hand-typed id, and the mismatch check below still has
          // something to compare when --customer IS given.
          customerId: customerArg ?? (await paddle.subscriptions.get(subscriptionArg)).customerId,
          subscriptionId: subscriptionArg,
        },
      ]
    : rows
        .filter((r) => (subArg ? r.sub === subArg : true))
        .flatMap((r) =>
          r.paddleCustomerId && r.paddleSubscriptionId
            ? [{ sub: r.sub, subscriptionActive: r.subscriptionActive as boolean | null, customerId: r.paddleCustomerId, subscriptionId: r.paddleSubscriptionId }]
            : [],
        );

console.log(`Paddle ${paddleEnvName} (PADDLE_ENVIRONMENT=${rawPaddleEnv}) · ${targets.length} subscription(s)${subArg ? ` matching --sub ${subArg}` : ""}`);
for (const t of targets) await inspect(t);
console.log("");
process.exit(0);
