/**
 * The deposit gate, as pure functions (PROD.md "Free-tier entitlement flip").
 *
 * It lives here rather than inline in `App.tsx` because it is the single rule that decides whether a
 * user may back up at all — the thing most worth getting right and hardest to notice when it's wrong
 * (a gate that wrongly says "no" looks exactly like a working paywall).
 *
 * ONE question: is there room for what's being deposited? Every signed-in account has a byte quota —
 * the free tier (see `resolveFreeTierBytes` in the account backend), or the plan's — and only a deposit
 * that would OVERFLOW that quota is blocked. Whether someone pays is not part of this decision; `active`
 * only picks which upsell the block shows.
 *
 * Two things the gate MUST count as "used", or it leaks:
 *   1. `bytesStored` — a live S3 listing of what's already in the vault. It LAGS: it starts at 0 on a
 *      fresh vault and only refreshes when a run finishes. Comparing a deposit against this number alone
 *      lets you pour multiple GB into a 1 GB vault before it ever catches up.
 *   2. In-flight bytes — deposits already dispatched but not yet reflected in `bytesStored` (the
 *      optimistic "uploading" rows). Without these, a burst of deposits all measure against the same
 *      stale stored total and every one passes.
 * The caller sums the two into `usedBytes` and passes it here; the gate then also weighs the SIZE of the
 * incoming deposit (`hasCapacityFor`), which is what stops a single oversized drop the stored total can't.
 *
 * Fails OPEN on anything unknown, deliberately. This is the soft app-side gate (the hard one is IAM);
 * a transient null from a daemon that hasn't reported usage yet, or an entitlement that hasn't landed,
 * must never look like "you're out of room". Refusing a paying customer's backup over a missing number
 * is a far worse failure than letting a few extra bytes through.
 */
import type { EntitlementStatus } from "../../../shared/ipc.ts";

/** Bytes still free before the quota bites, given everything already used (stored + in-flight). `null`
 *  when quota or usage is unknown — the gate reads that as "don't enforce" (fails open). A negative
 *  number means already over quota. */
export const bytesAvailable = (entitlement: EntitlementStatus, usedBytes: number | null): number | null =>
  entitlement.quotaBytes == null || usedBytes == null ? null : entitlement.quotaBytes - usedBytes;

/** Would depositing `incomingBytes` more still fit under the quota? Unknown quota/usage ⇒ open (see the
 *  module note on failing open). `incomingBytes` of 0 answers the coarse "is there ANY room?" question. */
export const hasCapacityFor = (
  entitlement: EntitlementStatus,
  usedBytes: number | null,
  incomingBytes: number,
): boolean => {
  const available = bytesAvailable(entitlement, usedBytes);
  return available == null || incomingBytes <= available;
};
