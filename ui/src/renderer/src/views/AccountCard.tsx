/**
 * The sidebar's pinned account card (bottom-left, the standard SaaS pattern): avatar initial +
 * who's signed in + the storage meter, Google-Drive style — the bar and "X of Y used" live right
 * in the tile, so how full the vault is never needs a trip to Settings. Clicking it lands on
 * Settings, where the full manage surface lives (change plan / cancel / payment method). Rendered
 * only for a configured (multi-user) signed-in install — dogfood mode has no account to show.
 */
import { Badge } from "../ui/primitives.tsx";
import { formatBytes } from "./files/model.ts";
import type { SubscriptionInfo } from "../../../shared/ipc.ts";

const shortDate = (iso: string): string =>
  new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });

export const AccountCard = ({
  email,
  subscription,
  active,
  usedBytes,
  quotaBytes,
  onClick,
}: {
  email: string;
  subscription: SubscriptionInfo | null;
  /** The entitlement flag (webhook-fed) — the badge's fallback when the plan is unknown. */
  active: boolean;
  /** Stored + in-flight — the same figure the deposit gate measures against. Null until the daemon reports. */
  usedBytes: number | null;
  /** The plan's byte cap (webhook-fed); null = unknown, and the meter degrades to a plain "X stored" line. */
  quotaBytes: number | null;
  onClick: () => void;
}): React.JSX.Element => {
  // Both halves known → an honest fraction; otherwise no bar (a made-up fill would lie).
  const fraction =
    usedBytes != null && quotaBytes != null && quotaBytes > 0
      ? Math.min(1, usedBytes / quotaBytes)
      : null;
  return (
    <button type="button" className="cs-account" onClick={onClick} title="Account & plan settings">
      <span className="cs-account-avatar" aria-hidden="true">
        {email.charAt(0).toUpperCase()}
      </span>
      <span className="cs-account-info">
        <span className="cs-account-head">
          <span className="cs-account-email">{email}</span>
          {subscription?.cancelsAt ? (
            <Badge tone="warning">Ends {shortDate(subscription.cancelsAt)}</Badge>
          ) : subscription?.plan ? (
            // The size badge only when the meter can't show it — "6 GB of 25 GB used" already names
            // the plan size, and a "25 GB" badge next to it would say the same thing twice.
            fraction != null ? null : <Badge tone="accent">{subscription.plan.size}</Badge>
          ) : active ? (
            <Badge tone="success">Active</Badge>
          ) : (
            // Not "No plan" — since the free tier landed, no subscription IS a plan: 25 GB, forever, and it
            // backs up like any other. Naming it "Free" is the honest label AND the one that makes the
            // usage line ("6 GB of 25 GB used") read as a plan filling up rather than a locked account.
            <Badge tone="neutral">Free</Badge>
          )}
        </span>
        {usedBytes != null && (
          <span className="cs-account-meter">
            {fraction != null && quotaBytes != null && (
              <span
                className="cs-account-track"
                role="meter"
                aria-label="Storage used"
                aria-valuemin={0}
                aria-valuemax={quotaBytes}
                aria-valuenow={Math.min(usedBytes, quotaBytes)}
              >
                <span
                  className={`cs-account-fill${
                    fraction >= 1 ? " cs-account-fill--over" : fraction >= 0.9 ? " cs-account-fill--near" : ""
                  }`}
                  style={{ width: `${fraction * 100}%` }}
                />
              </span>
            )}
            <span className="cs-account-usage">
              {quotaBytes != null
                ? `${formatBytes(usedBytes)} of ${formatBytes(quotaBytes)} used`
                : `${formatBytes(usedBytes)} stored`}
            </span>
          </span>
        )}
      </span>
    </button>
  );
};
