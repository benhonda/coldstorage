/**
 * What billing state is this account in — as ONE pure function, for ONE reason.
 *
 * The app used to answer this twice: the sidebar chip derived a plan badge from
 * `(subscription, entitlement.active)`, and Settings derived a card from the same two values with a
 * different set of rules. Two copies of one question drift, and they had: a subscriber whose
 * entitlement hadn't loaded read as "Free" in one place and "Active" in the other.
 *
 * Worse, `SubscriptionInfo | null` conflated three different worlds — "still loading", "this account
 * never subscribed", and "we asked and the answer didn't come back". The renderer caught fetch
 * failures into `null`, so a Paddle outage or an expired token rendered as a healthy free account:
 * a green **Active** badge (webhook-fed, cached, still true) above a card with no plan, no price and
 * no way to cancel. The user is paying and the app shows them nothing they can act on.
 *
 * So: {@link Loadable} keeps "didn't come back" a first-class answer, and {@link BillingState} is a
 * closed union — every state names itself, and the panel's header has a branch for each. There is no
 * shape a failure can take that falls through to a blank card.
 */
import type { EntitlementStatus, PaymentMethodInfo, SubscriptionInfo } from "../../../shared/ipc.ts";

/** An async value that hasn't collapsed its failure case into its empty case. */
export type Loadable<T> =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; value: T };

/**
 * Every billing state the app can be in, closed. `sub` rides along on the four subscribed states
 * because the panel's columns (plan, usage, card, next charge) render from it — and the states
 * WITHOUT a subscription structurally can't reach those fields.
 */
export type BillingState =
  /** The subscription read is in flight — first paint, or a retry. */
  | { kind: "loading" }
  /** We asked and didn't get an answer. Carries what to tell the user, and earns a Retry. */
  | { kind: "unavailable"; message: string }
  /** A checkout is open in the browser and we're waiting on the webhook. */
  | { kind: "checkingOut" }
  /** No subscription, and that's the truth rather than a missing answer: the free tier. */
  | { kind: "free" }
  | { kind: "active"; sub: SubscriptionInfo }
  /** A cancellation is already scheduled — `endsAt` is when the plan stops. */
  | { kind: "ending"; sub: SubscriptionInfo; endsAt: string }
  /** Paddle couldn't take payment. The one state that is urgent and silent today. */
  | { kind: "pastDue"; sub: SubscriptionInfo }
  | { kind: "paused"; sub: SubscriptionInfo };

/**
 * Fold the two independent signals — the subscription read and the webhook-fed entitlement — into the
 * one state the UI renders. Order is the whole design; each guard says why it outranks the next.
 */
export const billingState = (
  subscription: Loadable<SubscriptionInfo | null>,
  entitlement: EntitlementStatus,
): BillingState => {
  // A checkout open in the browser outranks everything: it's the thing the user is doing RIGHT NOW,
  // and until the webhook lands the subscription read still legitimately says "nothing here".
  if (entitlement.checkingOut) return { kind: "checkingOut" };

  if (subscription.status === "loading") return { kind: "loading" };
  if (subscription.status === "error") return { kind: "unavailable", message: subscription.message };

  // Entitlement hasn't been fetched even once, so `active` below is meaningless — not false. Waiting
  // is honest; guessing "Free" at a subscriber is not.
  if (!entitlement.known) return { kind: "loading" };

  if (subscription.value === null) {
    // The webhook says this account pays; the billing server says it has no subscription to show.
    // Both can't be right, and quietly picking one is how a paying customer gets a free-tier screen.
    // Say it's broken and let them retry.
    if (entitlement.active) {
      return {
        kind: "unavailable",
        message: "Your account is marked as subscribed, but we couldn't load the subscription itself.",
      };
    }
    return { kind: "free" };
  }

  const sub = subscription.value;
  // A scheduled cancellation outranks the raw status (Paddle still reports "active" until it ends) —
  // it's the fact the user most needs to see, and the only one with an undo attached.
  if (sub.cancelsAt) return { kind: "ending", sub, endsAt: sub.cancelsAt };
  if (sub.status === "past_due") return { kind: "pastDue", sub };
  if (sub.status === "paused") return { kind: "paused", sub };
  return { kind: "active", sub };
};

/** The subscription behind a state, for the panel's columns. Null wherever there isn't one. */
export const subscriptionOf = (state: BillingState): SubscriptionInfo | null =>
  state.kind === "active" || state.kind === "ending" || state.kind === "pastDue" || state.kind === "paused"
    ? state.sub
    : null;

/** Tone + label for the sidebar chip's badge, in two lengths (the avatar has room for one word; the
 *  popover has room for a sentence fragment). The chip renders this — it no longer decides it. */
export interface PlanBadge {
  tone: "neutral" | "accent" | "success" | "warning" | "danger";
  short: string;
  long: string;
}

export const planBadge = (state: BillingState, formatDate: (iso: string) => string): PlanBadge => {
  switch (state.kind) {
    case "loading":
    case "checkingOut":
      return { tone: "neutral", short: "…", long: "Checking…" };
    // The chip is small and always on screen; it says only that something's wrong, and Settings ›
    // Account says what. A silent chip here is what let the broken card hide in the first place.
    case "unavailable":
      return { tone: "danger", short: "!", long: "Billing unavailable" };
    // Not "No plan": since the free tier landed, no subscription IS a plan — 25 GB, forever, backing
    // up like any other. "Free" reads as a plan filling up rather than a locked account.
    case "free":
      return { tone: "neutral", short: "Free", long: "Free" };
    case "ending":
      return { tone: "warning", short: "Ends", long: `Ends ${formatDate(state.endsAt)}` };
    case "pastDue":
      return { tone: "danger", short: "!", long: "Payment failed" };
    case "paused":
      return { tone: "warning", short: "Paused", long: "Paused" };
    case "active":
      return state.sub.plan
        ? { tone: "accent", short: state.sub.plan.size, long: state.sub.plan.size }
        : { tone: "success", short: "Active", long: "Active" };
  }
};

/**
 * Would the chip's badge just repeat what the storage meter already says? Only in one case: an active
 * plan whose size the meter is already naming ("6 GB of 25 GB used"), so a "25 GB" badge under the
 * avatar says it twice.
 *
 * A predicate rather than an inline condition because the obvious version of it — "there's a plan and
 * no cancellation date" — silently swallowed the badge for a PAST-DUE subscription, whose badge is the
 * only warning the chip carries. Every other state's badge must survive a rendering meter.
 */
export const badgeIsRedundant = (state: BillingState, meterVisible: boolean): boolean =>
  state.kind === "active" && state.sub.plan !== null && meterVisible;

/**
 * Money as the customer's own bill states it. Currency-aware because Paddle bills in the customer's
 * currency — a hardcoded `$` in front of a EUR renewal is a wrong number, not a cosmetic slip.
 */
export const formatMoney = (amountCents: number, currency: string): string =>
  new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amountCents / 100);

/** The card on file in one line: "Visa ···· 4242". Non-card methods just name themselves ("PayPal"). */
export const describePaymentMethod = (pm: PaymentMethodInfo): string => {
  const raw = pm.brand ?? pm.type;
  const name = raw === "paypal" ? "PayPal" : raw.charAt(0).toUpperCase() + raw.slice(1);
  return pm.last4 ? `${name} ···· ${pm.last4}` : name;
};

/** "exp 09/28" — null when the method has no expiry (PayPal, wallets). */
export const describeExpiry = (pm: PaymentMethodInfo): string | null =>
  pm.expiryMonth != null && pm.expiryYear != null
    ? `exp ${String(pm.expiryMonth).padStart(2, "0")}/${String(pm.expiryYear).slice(-2)}`
    : null;
