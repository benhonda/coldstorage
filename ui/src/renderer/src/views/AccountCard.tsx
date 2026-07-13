/**
 * The sidebar's pinned account card (bottom-left, the standard SaaS pattern): avatar initial +
 * who's signed in + the plan as a badge. Clicking it lands on Settings, where the full manage
 * surface lives (change plan / cancel / payment method). Rendered only for a configured
 * (multi-user) signed-in install — dogfood mode has no account to show.
 */
import { Badge } from "../ui/primitives.tsx";
import type { SubscriptionInfo } from "../../../shared/ipc.ts";

const shortDate = (iso: string): string =>
  new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });

export const AccountCard = ({
  email,
  subscription,
  active,
  onClick,
}: {
  email: string;
  subscription: SubscriptionInfo | null;
  /** The entitlement flag (webhook-fed) — the badge's fallback when the plan is unknown. */
  active: boolean;
  onClick: () => void;
}): React.JSX.Element => (
  <button type="button" className="cs-account" onClick={onClick} title="Account & plan settings">
    <span className="cs-account-avatar" aria-hidden="true">
      {email.charAt(0).toUpperCase()}
    </span>
    <span className="cs-account-info">
      <span className="cs-account-email">{email}</span>
      {subscription?.cancelsAt ? (
        <Badge tone="warning">Ends {shortDate(subscription.cancelsAt)}</Badge>
      ) : subscription?.plan ? (
        <Badge tone="accent">{subscription.plan.size}</Badge>
      ) : active ? (
        <Badge tone="success">Active</Badge>
      ) : (
        // Not "No plan" — since the free tier landed, no subscription IS a plan: 25 GB, forever, and it
        // backs up like any other. Naming it "Free" is the honest label AND the one that makes the
        // Settings usage row ("6 GB of 25 GB") read as a plan filling up rather than a locked account.
        <Badge tone="neutral">Free</Badge>
      )}
    </span>
  </button>
);
