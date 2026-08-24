/**
 * Settings › Account › **Plan & billing** — a status-first panel.
 *
 * It renders a STATE, not a list of fields, and that distinction is the whole point. The old card was
 * a stack of rows each gated on `subscription != null`; when the subscription read failed, every row
 * that could act on it silently disappeared and what remained was a green "Active" badge above a
 * storage figure. A paying customer looking at a card that offers them nothing (PILLAR5: no silent
 * failures — least of all on the surface where someone's money lives).
 *
 * So the header is a closed switch over {@link BillingState}: every state, including "we couldn't load
 * this", has exactly one sentence and one primary action. There is no fall-through.
 *
 * Below it, two columns of detail, present whenever there's a subscription to describe them:
 *   · **Your plan** — size/term, the usage meter, and Change plan (the priced, prorated decision we
 *     keep in-app because our preview is better than a hosted page's).
 *   · **Payments** — the card on file, the next charge (amount AND date), and one link into Paddle's
 *     customer portal for invoices, receipts, billing address and tax id. We don't re-render Paddle's
 *     ledger: it is the merchant of record and the SSOT for money (PILLAR3).
 */
import type { ReactNode } from "react";
import { useState } from "react";
import type { ColdstoreApi, SubscriptionInfo } from "../../../shared/ipc.ts";
import {
  describeExpiry,
  describePaymentMethod,
  formatMoney,
  subscriptionOf,
  type BillingState,
} from "../state/billing.ts";
import { formatBytes } from "./files/model.ts";
import { Badge, Button, Card, Icon, Skeleton } from "../ui/primitives.tsx";
import type { Exec } from "./types.ts";

/** One header: what's true right now, and the one thing to do about it. */
interface Header {
  tone: "neutral" | "accent" | "success" | "danger" | "warning";
  icon: string;
  /** The sentence. Says the state AND its consequence — "Ends Mar 4" alone is a warning with no
   *  information in it. */
  line: ReactNode;
  /** Extra context that only some states need (the dunning explanation, the load error). */
  detail?: string;
  action?: { label: string; icon: string; variant?: "primary" | "secondary" | "danger"; onClick: () => void };
}

export const BillingPanel = ({
  api,
  exec,
  billing,
  bytesStored,
  bytesStoredPending,
  quotaBytes,
  onSubscribe,
  onChangePlan,
  onSubscriptionChanged,
  onRetry,
}: {
  api: ColdstoreApi;
  exec: Exec;
  /** The one shared fold (App) — the sidebar chip renders the same value. */
  billing: BillingState;
  bytesStored: number | null;
  bytesStoredPending: boolean;
  quotaBytes: number | null;
  /** Free tier → open the plan picker (checkout). */
  onSubscribe: () => void;
  /** Subscribed → open the prorated change-plan modal (owned by SettingsView). */
  onChangePlan: () => void;
  /** A change we made here (un-cancel) — hand the fresh summary back to App. */
  onSubscriptionChanged: (sub: SubscriptionInfo) => void;
  /** Re-run the subscription read behind the `unavailable` state. */
  onRetry: () => void;
}): React.JSX.Element => {
  // In flight for an action we own (un-cancel). The button says so rather than looking inert —
  // every async operation gets an honest pending state.
  const [resuming, setResuming] = useState(false);

  const shortDate = (iso: string): string =>
    new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

  const resume = (): void => {
    setResuming(true);
    exec(() =>
      api
        .resumeSubscription()
        .then(onSubscriptionChanged)
        .finally(() => setResuming(false)),
    );
  };

  // The switch is exhaustive over BillingState — a new state is a type error here, not a blank card.
  const header = ((): Header => {
    switch (billing.kind) {
      case "loading":
        return { tone: "neutral", icon: "hourglass_empty", line: <Skeleton width="28ch" label="Loading your plan" /> };
      case "unavailable":
        return {
          tone: "danger",
          icon: "error",
          line: "We couldn't load your billing details",
          // The reason, verbatim from the server. Someone paying deserves to know whether this is a
          // sign-in problem or ours — and it's what makes a support message useful.
          detail: billing.message,
          action: { label: "Try again", icon: "refresh", onClick: onRetry },
        };
      case "checkingOut":
        return { tone: "accent", icon: "hourglass_top", line: "Finishing your subscription in your browser…" };
      case "free":
        return {
          tone: "neutral",
          icon: "cloud",
          // The size comes from the entitlement (the backend's `resolveFreeTierBytes` is the SSOT) —
          // a literal "25 GB" here goes stale the day that number moves.
          line: quotaBytes != null ? `Free — ${formatBytes(quotaBytes)}, no card needed` : "Free — no card needed",
          // Same icon the sidebar chip's Upgrade item uses — one action, one look, wherever it appears.
          // No "Finishing…" label here: an open checkout is its own state above, never this one.
          action: { label: "Upgrade", icon: "rocket_launch", variant: "primary", onClick: onSubscribe },
        };
      case "active": {
        const { sub } = billing;
        const renews = sub.nextBilledAt ? `renews ${shortDate(sub.nextBilledAt)}` : "renews automatically";
        const amount = sub.nextCharge ? ` · ${formatMoney(sub.nextCharge.amountCents, sub.nextCharge.currency)}` : "";
        return {
          tone: "success",
          icon: "check_circle",
          line: `Active · ${renews}${amount}`,
          action: { label: "Change plan", icon: "swap_horiz", onClick: onChangePlan },
        };
      }
      case "ending":
        return {
          tone: "warning",
          icon: "event",
          line: `Ends ${shortDate(billing.endsAt)}`,
          // The reassurance belongs here, not in a support email: cancelling doesn't delete anything
          // before the date, and changing your mind is one click.
          detail: "Your files stay exactly where they are until then.",
          action: {
            label: resuming ? "Restoring…" : "Keep my plan",
            icon: "undo",
            variant: "primary",
            onClick: resume,
          },
        };
      case "pastDue":
        return {
          tone: "danger",
          icon: "credit_card_off",
          line: "We couldn't take payment",
          detail: "Your backups keep running while we retry. Updating your card fixes it straight away.",
          action: {
            label: "Update card",
            icon: "credit_card",
            variant: "primary",
            onClick: () => exec(() => api.openManage("payment")),
          },
        };
      case "paused":
        return {
          tone: "warning",
          icon: "pause_circle",
          line: "Paused",
          detail: "Nothing new is being backed up. What's already in deep storage stays there.",
          action: { label: "Manage billing", icon: "open_in_new", onClick: () => exec(() => api.openManage("overview")) },
        };
    }
  })();

  const sub = subscriptionOf(billing);
  const fraction =
    bytesStored != null && quotaBytes != null && quotaBytes > 0 ? Math.min(1, bytesStored / quotaBytes) : null;

  // ONE number, one meaning: `bytesStored` is a live listing of the user's own vault — every device
  // they've deposited from, and the figure the plan's quota is enforced against.
  const usage: ReactNode =
    bytesStored == null ? (
      bytesStoredPending ? (
        <Skeleton width="14ch" label="Checking deep storage total" />
      ) : (
        "—"
      )
    ) : quotaBytes != null ? (
      `${formatBytes(bytesStored)} of ${formatBytes(quotaBytes)}`
    ) : (
      formatBytes(bytesStored)
    );

  return (
    <Card title="Plan & billing">
      <div className={`cs-billing-head cs-billing-head--${header.tone}`}>
        <Icon name={header.icon} size={22} />
        <div className="cs-billing-head-text">
          <div className="cs-billing-head-line">{header.line}</div>
          {header.detail && <div className="cs-billing-head-detail">{header.detail}</div>}
        </div>
        {header.action && (
          <Button
            size="sm"
            icon={header.action.icon}
            variant={header.action.variant ?? "secondary"}
            disabled={billing.kind === "ending" && resuming}
            onClick={header.action.onClick}
          >
            {header.action.label}
          </Button>
        )}
      </div>

      <div className="cs-billing-cols">
        <section className="cs-billing-col">
          <h4 className="cs-billing-col-title">Your plan</h4>
          <div className="cs-billing-plan">
            {sub?.plan ? (
              <Badge tone="accent">
                {sub.plan.size} · {sub.plan.years} yr{sub.plan.years > 1 ? "s" : ""}
              </Badge>
            ) : sub ? (
              // A price that predates the current plan lineup (e.g. sold before a catalog reshape) —
              // still fully changeable; the picker just starts from the default.
              <Badge tone="neutral">Earlier plan</Badge>
            ) : (
              <Badge tone="neutral">{quotaBytes != null ? `Free · ${formatBytes(quotaBytes)}` : "Free"}</Badge>
            )}
          </div>
          {/* The meter lives beside its remedy. No bar unless both halves are known — a made-up fill lies. */}
          {fraction != null && quotaBytes != null && bytesStored != null && (
            <span
              className="cs-billing-track"
              role="meter"
              aria-label="Storage used"
              aria-valuemin={0}
              aria-valuemax={quotaBytes}
              aria-valuenow={Math.min(bytesStored, quotaBytes)}
            >
              <span
                className={`cs-billing-fill${
                  fraction >= 1 ? " cs-billing-fill--over" : fraction >= 0.9 ? " cs-billing-fill--near" : ""
                }`}
                style={{ width: `${fraction * 100}%` }}
              />
            </span>
          )}
          <div className="cs-billing-usage">
            <span className="cs-muted">In deep storage</span> {usage}
          </div>
        </section>

        <section className="cs-billing-col">
          <h4 className="cs-billing-col-title">Payments</h4>
          {sub ? (
            <>
              <div className="cs-billing-pm">
                {sub.paymentMethod ? (
                  <>
                    <Icon name="credit_card" size={18} />
                    <span>{describePaymentMethod(sub.paymentMethod)}</span>
                    {describeExpiry(sub.paymentMethod) && (
                      <span className="cs-muted">{describeExpiry(sub.paymentMethod)}</span>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => exec(() => api.openManage("payment"))}>
                      Update
                    </Button>
                  </>
                ) : (
                  // Known-absent, not pending — say so in words rather than leaving the row blank.
                  <>
                    <span className="cs-muted">No card saved</span>
                    <Button size="sm" onClick={() => exec(() => api.openManage("payment"))}>
                      Add one
                    </Button>
                  </>
                )}
              </div>
              <div className="cs-billing-next">
                {sub.nextCharge && sub.nextBilledAt ? (
                  <>
                    <span className="cs-muted">Next charge</span>{" "}
                    {formatMoney(sub.nextCharge.amountCents, sub.nextCharge.currency)} on {shortDate(sub.nextBilledAt)}
                  </>
                ) : (
                  <span className="cs-muted">No further charges scheduled</span>
                )}
              </div>
              {/* Everything we deliberately don't rebuild — invoices, receipts, billing address, VAT id,
                  and cancelling — behind one honest link. It opens in the browser (Paddle's own pages). */}
              <button
                type="button"
                className="cs-billing-portal"
                onClick={() => exec(() => api.openManage("overview"))}
              >
                Invoices, receipts &amp; billing details
                <Icon name="open_in_new" size={16} />
              </button>
              {billing.kind !== "ending" && (
                <button
                  type="button"
                  className="cs-billing-cancel"
                  onClick={() => exec(() => api.openManage("cancel"))}
                >
                  Cancel subscription
                </button>
              )}
            </>
          ) : (
            <div className="cs-muted">Nothing to bill — the free tier doesn&apos;t need a card.</div>
          )}
        </section>
      </div>
    </Card>
  );
};
