/**
 * Change the subscription's plan (size × term) — the in-app half of "manage subscription"
 * (cancel + payment method are Paddle-hosted pages; see PADDLE.md "Managing a subscription").
 * Same {@link PlanPicker} as the paywall, seeded with the CURRENT plan; picking a different one
 * fetches a proration preview so the money is on the table before anything commits: upgrades
 * charge the difference now, downgrades become credit against future bills.
 */
import { useEffect, useState } from "react";
import { Alert, Button, Modal } from "../ui/primitives.tsx";
import { PlanPicker, usd } from "./PlanPicker.tsx";
import { formatBytes } from "./files/model.ts";
import type { CatalogPlan, ColdstoreApi, PlanChangePreview, SubscriptionInfo } from "../../../shared/ipc.ts";

const shortDate = (iso: string): string =>
  new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

export const ChangePlanModal = ({
  api,
  current,
  bytesStored,
  onChanged,
  onClose,
}: {
  api: ColdstoreApi;
  current: SubscriptionInfo;
  /** Authoritative (S3-derived) total currently stored — drives the downgrade-below-usage warning below.
   * Null = unknown (dogfood/unconfigured, or before the first daemon listing lands); no warning shown. */
  bytesStored: number | null;
  /** Fires with the fresh summary once the change is applied (the caller updates its state). */
  onChanged: (sub: SubscriptionInfo) => void;
  onClose: () => void;
}): React.JSX.Element => {
  const [plans, setPlans] = useState<CatalogPlan[] | null>(null);
  const [selected, setSelected] = useState<CatalogPlan | undefined>(undefined);
  const [preview, setPreview] = useState<PlanChangePreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .getPlanCatalog()
      .then((p) => alive && setPlans(p))
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [api]);

  const isCurrent = selected?.priceId === current.plan?.priceId;
  // Non-blocking: a downgrade doesn't touch stored data, it just means new deposits pause until usage
  // drops back under the new cap. Warn plainly, don't prevent the switch.
  const overCapacityAfterSwitch = selected && !isCurrent && bytesStored != null && selected.quotaBytes < bytesStored;

  // Preview the money whenever a DIFFERENT plan is picked (read-only; nothing commits here).
  useEffect(() => {
    setPreview(null);
    if (!selected || isCurrent) return;
    let alive = true;
    setPreviewing(true);
    setError(null);
    api
      .previewPlanChange(selected.priceId)
      .then((p) => alive && setPreview(p))
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => alive && setPreviewing(false));
    return () => {
      alive = false;
    };
  }, [api, selected, isCurrent]);

  const apply = (): void => {
    if (!selected) return;
    setApplying(true);
    setError(null);
    api
      .changePlan(selected.priceId)
      .then((sub) => {
        onChanged(sub);
        onClose();
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
        setApplying(false);
      });
  };

  return (
    <Modal
      title="Change your plan"
      icon="swap_horiz"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={applying}>
            Keep current plan
          </Button>
          <Button variant="primary" disabled={!selected || isCurrent || previewing || applying} onClick={apply}>
            {applying ? "Switching…" : selected && !isCurrent ? `Switch to ${selected.size}` : "Switch plan"}
          </Button>
        </>
      }
    >
      {plans === null && !error ? (
        <p className="cs-plan-lock">Loading plans…</p>
      ) : (
        plans && (
          <>
            <PlanPicker plans={plans} initial={current.plan} onSelect={setSelected} />
            {isCurrent ? (
              <p className="cs-plan-now">This is your current plan.</p>
            ) : previewing ? (
              <p className="cs-plan-now">Checking what this changes…</p>
            ) : preview ? (
              <p className="cs-plan-now">
                {preview.action === "charge"
                  ? `You'll be charged ${usd(preview.amountCents)} now for the rest of your term.`
                  : `You'll get ${usd(preview.amountCents)} in credit, applied to your future bills.`}
                {preview.nextBilledAt ? ` Your plan renews on ${shortDate(preview.nextBilledAt)}.` : ""}
              </p>
            ) : null}
            {overCapacityAfterSwitch && bytesStored != null && selected && (
              <p className="cs-plan-now">
                You&apos;re using {formatBytes(bytesStored)}, more than this plan&apos;s {formatBytes(selected.quotaBytes)}. You can
                still switch, but new backups will pause until you&apos;re back under the limit.
              </p>
            )}
          </>
        )
      )}
      {error && <Alert>{error}</Alert>}
    </Modal>
  );
};
