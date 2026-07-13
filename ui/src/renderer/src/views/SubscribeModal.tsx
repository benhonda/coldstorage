/**
 * Paywall + plan picker (PROD.md Phase 5c · PADDLE.md "Multi-plan picker") — shown when a signed-in
 * user without an active subscription tries to deposit. A soft gate: backing up NEW files needs a
 * subscription, but anything already stored stays restorable (say so — no holding data hostage).
 *
 * The catalog is fetched live from the billing server (annual sizes, exactly what Paddle will sell) —
 * never hardcoded here. The picker itself is the shared {@link PlanPicker} (also used by
 * ChangePlanModal). "Subscribe" opens Paddle checkout in the system browser for the chosen plan;
 * while that's open we poll, and the modal reflects `checkingOut` until the webhook lands.
 */
import { useEffect, useState } from "react";
import { Alert, Button, Modal } from "../ui/primitives.tsx";
import { PlanPicker } from "./PlanPicker.tsx";
import type { CatalogPlan, ColdstoreApi, EntitlementStatus } from "../../../shared/ipc.ts";

export const SubscribeModal = ({
  api,
  entitlement,
  onSubscribe,
  onClose,
}: {
  api: ColdstoreApi;
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

  return (
    <Modal
      title="Subscribe to keep backing up"
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
            A subscription lets coldstorage keep backing up your new and changed files. Anything you&apos;ve
            already stored stays available to get back, subscription or not.
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
