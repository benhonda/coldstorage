/**
 * Plan picker (PROD.md "Free-tier entitlement flip" · PADDLE.md "Multi-plan picker"). Two moments,
 * one modal — hence {@link PaywallReason}:
 *
 *  - `quotaReached` — a free account has filled its 25 GB and a deposit was blocked. Since the free tier
 *    landed this is the ONLY blocking case, and it's a full vault, not an unsubscribed one: a plan raises
 *    the cap. Never gate on "you haven't paid".
 *  - `upgrade` — nobody is blocked; they chose "Subscribe" in Settings with room to spare.
 *
 * Soft either way, and say so: anything already stored stays restorable, plan or no plan (small restores
 * are free under the monthly allowance) — we don't hold data hostage.
 *
 * The catalog is fetched live from the billing server (annual sizes, exactly what Paddle will sell) —
 * never hardcoded here. The picker itself is the shared {@link PlanPicker} (also used by
 * ChangePlanModal). "Subscribe" opens Paddle checkout in the system browser for the chosen plan;
 * while that's open we poll, and the modal reflects `checkingOut` until the webhook lands.
 */
import { useEffect, useState } from "react";
import { Alert, Button, Modal } from "../ui/primitives.tsx";
import { PlanPicker } from "./PlanPicker.tsx";
import { formatBytes } from "./files/model.ts";
import type { CatalogPlan, ColdstoreApi, EntitlementStatus } from "../../../shared/ipc.ts";

/** Why the picker is open: blocked mid-deposit on a full free vault, or an upgrade by choice. */
export type PaywallReason = "quotaReached" | "upgrade";

export const SubscribeModal = ({
  api,
  reason,
  entitlement,
  onSubscribe,
  onClose,
}: {
  api: ColdstoreApi;
  reason: PaywallReason;
  entitlement: EntitlementStatus;
  onSubscribe: (priceId: string) => void;
  onClose: () => void;
}): React.JSX.Element => {
  const [plans, setPlans] = useState<CatalogPlan[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<CatalogPlan | undefined>(undefined);
  const [loadNonce, setLoadNonce] = useState(0); // bump to retry after a failed fetch

  useEffect(() => {
    let alive = true;
    setLoadError(null);
    api
      .getPlanCatalog()
      .then((p) => alive && setPlans(p))
      .catch((e: unknown) => alive && setLoadError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [api, loadNonce]);

  // The free cap, straight from the entitlement the backend handed us — never a hardcoded "25 GB" here
  // (it's a promise that can only move up, and it lives in the backend's plan-sizes SSOT).
  const freeCap = entitlement.quotaBytes == null ? null : formatBytes(entitlement.quotaBytes);

  return (
    <Modal
      title={reason === "quotaReached" ? "Your free storage is full" : "Choose a plan"}
      icon="workspace_premium"
      onClose={onClose}
      footer={
        entitlement.checkingOut ? undefined : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Not now
            </Button>
            <Button variant="primary" disabled={!selected} onClick={() => selected && onSubscribe(selected.priceId)}>
              {selected ? `Subscribe to ${selected.size}` : "Subscribe"}
            </Button>
          </>
        )
      }
    >
      {entitlement.checkingOut ? (
        <p className="cs-quote-lead">
          Finish checking out in your browser. This updates on its own once you&apos;re done — you can leave
          this open.
        </p>
      ) : (
        <>
          <p className="cs-quote-lead">
            {reason === "quotaReached"
              ? `You've used the ${freeCap ?? "free"} storage that comes with every account. A plan gives you more room, so coldstorage can keep backing up your new and changed files.`
              : `Every account gets ${freeCap ?? "free"} of storage. A plan gives you more room for new and changed files.`}{" "}
            Anything you&apos;ve already stored stays available to get back, plan or no plan.
          </p>

          {loadError ? (
            <>
              <Alert>{loadError}</Alert>
              <Button variant="secondary" onClick={() => setLoadNonce((n) => n + 1)}>
                Try again
              </Button>
            </>
          ) : plans === null ? (
            <p className="cs-plan-lock">Loading plans…</p>
          ) : (
            <PlanPicker plans={plans} onSelect={setSelected} />
          )}
        </>
      )}
      {entitlement.error && <Alert>{entitlement.error}</Alert>}
    </Modal>
  );
};
