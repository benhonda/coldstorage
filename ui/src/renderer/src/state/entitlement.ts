/**
 * The deposit gate, as one pure function (PROD.md "Free-tier entitlement flip").
 *
 * It lives here rather than inline in `App.tsx` because it is the single rule that decides whether a
 * user may back up at all — the thing most worth getting right and hardest to notice when it's wrong
 * (a gate that wrongly says "no" looks exactly like a working paywall).
 *
 * ONE question: is there room? Every signed-in account has a byte quota — the free tier's 25 GB, or the
 * plan's — and only a FULL vault blocks a deposit. Whether someone pays is not part of this decision;
 * `active` only picks which upsell the block shows.
 *
 * Fails OPEN on anything unknown, deliberately. This is the soft app-side gate (the hard one is IAM);
 * a transient null from a daemon that hasn't reported usage yet, or an entitlement that hasn't landed,
 * must never look like "you're out of room". Refusing a paying customer's backup over a missing number
 * is a far worse failure than letting a few extra bytes through.
 */
import type { EntitlementStatus } from "../../../shared/ipc.ts";

/** Is there room to deposit? The gate — see the module note. Unknown quota or usage ⇒ open. */
export const hasCapacity = (entitlement: EntitlementStatus, bytesStored: number | null): boolean =>
  entitlement.quotaBytes == null || bytesStored == null || bytesStored < entitlement.quotaBytes;
