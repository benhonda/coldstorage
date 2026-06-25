/**
 * Cost math — the ONE place the renderer turns bytes into a dollar figure, so Settings (storage/month)
 * and the request-a-copy dialog (retrieval fee) can't drift apart. The rate card is the daemon's
 * (`getPricing` → store `state.pricing`); this module only does bytes × rate + formatting.
 *
 * {@link FALLBACK_PRICING} mirrors the daemon defaults and seeds the store so the very first paint isn't
 * blank — it's replaced by the real quote the moment the controller fetches on connect. It is NOT a second
 * source of truth: the daemon owns the numbers; this is a loading placeholder kept in lockstep.
 */
import type { Pricing } from "../../../../shared/ipc.ts";

/** Loading placeholder — equals the daemon's `Pricing` defaults (Deep Archive, us-east-1 list prices). */
export const FALLBACK_PRICING: Pricing = {
  storageUsdPerGBMonth: 0.00099,
  retrieval: [
    { tier: "standard", usdPerGB: 0.02, typicalWait: "~12 hours" },
    { tier: "bulk", usdPerGB: 0.0025, typicalWait: "~48 hours" },
  ],
  note: "Estimate — public AWS list prices, before tax and small per-request fees.",
};

/** GB as AWS bills it (decimal, 1e9 bytes) — matches how the rates are quoted, not the binary GiB. */
const GB = 1_000_000_000;

/** Estimated monthly storage cost (USD) for `bytes` at the card's storage rate. */
export const monthlyStorageUsd = (pricing: Pricing, bytes: number): number =>
  (bytes / GB) * pricing.storageUsdPerGBMonth;

/** The retrieval quote (per-GB fee + typical wait) for a tier — defaults to the first/standard tier. */
export const retrievalTier = (pricing: Pricing, tier = "standard"): Pricing["retrieval"][number] | undefined =>
  pricing.retrieval.find((t) => t.tier === tier) ?? pricing.retrieval[0];

/** Estimated retrieval fee (USD) to bring `bytes` back at `tier`. */
export const retrievalUsd = (pricing: Pricing, bytes: number, tier = "standard"): number =>
  (bytes / GB) * (retrievalTier(pricing, tier)?.usdPerGB ?? 0);

/** Calm "~$X" with a 1-cent floor — a free/near-zero estimate still reads as a real, small number. */
export const formatUsd = (usd: number): string => (usd < 0.01 ? "~$0.01" : `~$${usd.toFixed(2)}`);
