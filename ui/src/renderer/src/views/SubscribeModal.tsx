/**
 * Paywall (PROD.md Phase 5c) — shown when a signed-in user without an active subscription tries to
 * deposit. A soft gate: backing up NEW files needs a subscription, but anything already stored stays
 * restorable (say so — no holding data hostage). "Subscribe" opens Paddle checkout in the system
 * browser; while that's open we poll, and the modal reflects `checkingOut` until the webhook lands.
 */
import { Alert, Button, Modal } from "../ui/primitives.tsx";
import type { EntitlementStatus } from "../../../shared/ipc.ts";

export const SubscribeModal = ({
  entitlement,
  onSubscribe,
  onClose,
}: {
  entitlement: EntitlementStatus;
  onSubscribe: () => void;
  onClose: () => void;
}): React.JSX.Element => (
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
          <Button variant="primary" onClick={onSubscribe}>
            Subscribe
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
      <p className="cs-quote-lead">
        A subscription lets coldstorage keep backing up your new and changed files. Anything you&apos;ve
        already stored stays available to get back, subscription or not.
      </p>
    )}
    {entitlement.error && <Alert>{entitlement.error}</Alert>}
  </Modal>
);
