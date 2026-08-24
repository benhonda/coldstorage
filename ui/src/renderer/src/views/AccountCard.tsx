/**
 * The sidebar's pinned identity chip (bottom-left, the standard SaaS pattern): avatar initial +
 * who's signed in + the storage meter, Google-Drive style — the bar and "X of Y used" live right
 * in the tile, so how full the vault is never needs a trip to Settings. Clicking it opens a small
 * popover (Discord/Slack convention) — identity summary + **Upgrade** (free accounts) +
 * **Settings…** (deep-links to Settings › Account, the full manage surface: change plan / cancel /
 * payment method) + **Sign out** — the chip never navigates directly. Rendered only for a
 * configured (multi-user) signed-in install — dogfood mode has no account to show, and so no
 * Account subpage either.
 *
 * **The plan badge sits on the avatar, not beside the name** (2026-07-27). It used to be the third
 * thing on one line — avatar, name, badge, caret, with the meter under all of it — inside a rail
 * that's 232px by default and can be dragged down to 200. At that width the name had almost nothing
 * left and truncated to a couple of characters. Hanging the badge off the avatar's bottom edge is
 * the usual fix for exactly this (the notification-dot pattern), and it hands the whole line back to
 * the name.
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Badge, Icon, Skeleton } from "../ui/primitives.tsx";
import { formatBytes } from "./files/model.ts";
import { badgeIsRedundant, planBadge, type BillingState } from "../state/billing.ts";

const shortDate = (iso: string): string =>
  new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });

export const AccountCard = ({
  email,
  displayName,
  billing,
  usedBytes,
  usagePending,
  quotaBytes,
  onOpenSettings,
  canUpgrade,
  onUpgrade,
  onSignOut,
}: {
  email: string;
  /** The user-owned display name (onboarding) — the primary line + avatar initial when present;
   * the card degrades to the email alone while it's still null. */
  displayName: string | null;
  /** The one shared billing fold (App). The chip RENDERS this badge; it no longer decides it —
   * deriving the answer here as well is how the chip and Settings drifted apart. */
  billing: BillingState;
  /** Stored + in-flight — the same figure the deposit gate measures against. Null until the daemon reports. */
  usedBytes: number | null;
  /** The usage figure is still on its way (daemon socket dialing), as opposed to genuinely unknown.
   * Drives the placeholder meter — see the render note below for why the distinction earns a prop. */
  usagePending: boolean;
  /** The plan's byte cap (webhook-fed); null = unknown, and the meter degrades to a plain "X stored" line. */
  quotaBytes: number | null;
  /** The popover's "Settings…" — routes to Settings › Account. */
  onOpenSettings: () => void;
  /** Whether to offer the upgrade item at all. Decided by App, not re-derived here: the sidebar's
   * upgrade button asks the same question, and two copies of the rule drifted (`!active` alone is true
   * for a subscriber whose entitlement hasn't loaded yet). */
  canUpgrade: boolean;
  /** Open the plan picker. A subscriber changes plan from Settings › Account instead, where the
   * proration preview lives. */
  onUpgrade: () => void;
  onSignOut: () => void;
}): React.JSX.Element => {
  // Popover anchor, measured from the chip at open time. Fixed-position + portaled (the chip is a
  // <button>, so the popover can't nest inside it); closes on click-away, Escape, or a resize —
  // same rule as ContextMenu: a stale anchor is worse than reopening.
  const [pop, setPop] = useState<{ left: number; bottom: number } | null>(null);
  const chipRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!pop) return;
    const close = (): void => setPop(null);
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") close();
    };
    // Capture phase (matches ContextMenu) so a stopPropagation elsewhere can't strand it open. The
    // chip itself is exempt — its own onClick owns the toggle, and closing here first would reopen.
    const onClickAway = (e: MouseEvent): void => {
      const t = e.target as Node;
      if (!popRef.current?.contains(t) && !chipRef.current?.contains(t)) close();
    };
    document.addEventListener("click", onClickAway, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("click", onClickAway, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
    };
  }, [pop]);

  const toggle = (): void => {
    if (pop) {
      setPop(null);
      return;
    }
    const r = chipRef.current?.getBoundingClientRect();
    if (r) setPop({ left: r.left, bottom: window.innerHeight - r.top + 8 });
  };

  // Both halves known → an honest fraction; otherwise no bar (a made-up fill would lie).
  const fraction =
    usedBytes != null && quotaBytes != null && quotaBytes > 0
      ? Math.min(1, usedBytes / quotaBytes)
      : null;

  // `short` is what fits on the avatar; `long` is what the popover has room to say (only the dated
  // states actually differ, and those are the ones where the difference matters most — "Ends" alone is
  // a warning with no information in it).
  const plan = planBadge(billing, shortDate);

  return (
    <>
      <button
        ref={chipRef}
        type="button"
        className="cs-account"
        onClick={toggle}
        title="Account"
        aria-haspopup="menu"
        aria-expanded={pop != null}
      >
        {/* Avatar + the plan badge hung off its bottom edge. `aria-hidden` covers the initial only —
            the badge is real information and stays in the accessibility tree. */}
        <span className="cs-account-mark">
          <span className="cs-account-avatar" aria-hidden="true">
            {(displayName ?? email).charAt(0).toUpperCase()}
          </span>
          {/* The badge is suppressed ONLY when it would be the redundant plan-size one — "6 GB of 25 GB
              used" already names the size, and a "25 GB" badge under the avatar says it twice. Keyed on
              the state, not on `plan != null`: every other state's badge is the only warning the chip
              carries (Ends / Payment failed / Billing unavailable) and must never be hidden by a meter
              that happens to be rendering. */}
          {badgeIsRedundant(billing, fraction != null) ? null : (
            <span className={`cs-account-mark-badge cs-account-mark-badge--${plan.tone}`}>{plan.short}</span>
          )}
        </span>
        <span className="cs-account-info">
          <span className="cs-account-head">
            <span className="cs-account-email">{displayName ?? email}</span>
          </span>
          {/* Three states, not two. The meter used to collapse entirely whenever `usedBytes` was null,
              which conflated "the daemon hasn't reported yet" with "there's nothing to report" — and did
              it while shifting the chip's layout as the value popped in. Pending now holds the space with
              a placeholder; a null usage with a live connection still collapses, because that's a real
              absence rather than a wait. */}
          {usedBytes == null && usagePending && (
            <span className="cs-account-meter">
              <Skeleton width="100%" height={4} label="Checking storage used" />
              <Skeleton width="11ch" />
            </span>
          )}
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
        <span className="cs-account-caret" aria-hidden="true">
          <Icon name="unfold_more" size={16} />
        </span>
      </button>

      {pop &&
        createPortal(
          <div
            ref={popRef}
            className="cs-account-pop"
            style={{ left: pop.left, bottom: pop.bottom }}
            role="menu"
            aria-label="Account"
          >
            <div className="cs-account-pop-head">
              <div className="cs-account-pop-name">{displayName ?? email}</div>
              {displayName != null && <div className="cs-account-pop-email">{email}</div>}
              <div className="cs-account-pop-plan">
                <Badge tone={plan.tone}>{plan.long}</Badge>
                {usedBytes != null && quotaBytes != null && (
                  <span>
                    {formatBytes(usedBytes)} of {formatBytes(quotaBytes)} used
                  </span>
                )}
              </div>
            </div>
            <div className="cs-menu-sep" />
            {/* First item, and the only accented one — someone who opens this menu looking for a way to buy
                more room shouldn't have to find it inside Settings. Subscribers don't see it: changing an
                existing plan is a priced, prorated decision, and it belongs on the surface that previews
                the charge (Settings › Account), not behind a one-word menu item. */}
            {canUpgrade && (
              <button
                type="button"
                className="cs-menu-item cs-menu-item--accent"
                role="menuitem"
                onClick={() => {
                  setPop(null);
                  onUpgrade();
                }}
              >
                <Icon name="rocket_launch" size={20} />
                Upgrade
              </button>
            )}
            <button
              type="button"
              className="cs-menu-item"
              role="menuitem"
              onClick={() => {
                setPop(null);
                onOpenSettings();
              }}
            >
              <Icon name="settings" size={20} />
              Settings…
            </button>
            <button
              type="button"
              className="cs-menu-item"
              role="menuitem"
              onClick={() => {
                setPop(null);
                onSignOut();
              }}
            >
              <Icon name="logout" size={20} />
              Sign out
            </button>
          </div>,
          document.body,
        )}
    </>
  );
};
