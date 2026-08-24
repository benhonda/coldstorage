import type { Route } from "./+types/($lang).checkout";
import * as React from "react";
import { useSearchParams } from "react-router";
import { Button } from "~/components/ds/button";

/**
 * Checkout page (Phase 3). Re-homed from the account-backend's brandless HTML page.
 *
 * Paddle Billing has no Paddle-hosted checkout: `transactions.create` returns a
 * `checkout.url` = the account's default payment link with `?_ptxn=<txn_id>` appended, and
 * THIS page's Paddle.js detects `_ptxn` and auto-opens the overlay. So the Paddle dashboard's
 * default-payment-link must point at `<this site>/checkout` (Phase 4 / Ben repoints it from
 * the account-backend URL). The authenticated transaction is still created server-side in
 * account-backend (`checkout-session`) — this page only opens the overlay.
 *
 * The page is a state machine around that one overlay, because the overlay has two exits and
 * neither used to be visible here (PILLAR5):
 * - paid → `settings.successUrl` sends the buyer back to `?done=1`, which replaces Paddle's own
 *   "we have emailed you details of your order" screen with ours. That message is Paddle's and
 *   isn't editable; redirecting past it is the supported way to own the moment.
 * - closed → `checkout.closed` lands us on a state with a way back in, instead of a page still
 *   claiming it's "opening secure checkout…".
 */
export function meta() {
  return [
    { title: "ColdStorage checkout" },
    // Transactional page — keep it out of search results.
    { name: "robots", content: "noindex" },
  ];
}

// Minimal Paddle.js surface we use (avoids `any`; the CDN script defines the rest).
type PaddleEvent = { name: string };
type PaddleJS = {
  Environment?: { set: (env: string) => void };
  Initialize: (opts: {
    token: string;
    eventCallback?: (event: PaddleEvent) => void;
    checkout?: { settings?: { successUrl?: string } };
  }) => void;
  Checkout: { open: (opts: { transactionId: string }) => void };
};
declare global {
  interface Window {
    Paddle?: PaddleJS;
  }
}

const PADDLE_SRC = "https://cdn.paddle.com/paddle/v2/paddle.js";

type Status = "loading" | "opening" | "closed" | "done" | "empty" | "unconfigured";

export default function Checkout() {
  const [params] = useSearchParams();
  const txnId = params.get("_ptxn");
  // Where `settings.successUrl` drops the buyer after Paddle takes the payment.
  const isDone = params.has("done");
  const [status, setStatus] = React.useState<Status>(isDone ? "done" : "loading");

  React.useEffect(() => {
    if (isDone) return;

    const token = window.env?.PUBLIC_PADDLE_CLIENT_TOKEN;
    const environment = window.env?.PUBLIC_PADDLE_ENVIRONMENT ?? "sandbox";

    if (!token) {
      setStatus("unconfigured");
      return;
    }
    // No transaction in the URL → someone hit /checkout directly; nothing to sell.
    if (!txnId) {
      setStatus("empty");
      return;
    }

    let cancelled = false;
    const init = () => {
      const Paddle = window.Paddle;
      if (!Paddle || cancelled) return;
      if (environment === "sandbox") Paddle.Environment?.set("sandbox");
      // Paddle.js auto-opens the overlay checkout for the ?_ptxn=<txn_id> in the URL.
      Paddle.Initialize({
        token,
        checkout: {
          settings: { successUrl: `${window.location.origin}${window.location.pathname}?done=1` },
        },
        eventCallback: (event) => {
          if (cancelled) return;
          if (event.name === "checkout.completed") setStatus("done");
          if (event.name === "checkout.closed") setStatus("closed");
        },
      });
      setStatus("opening");
    };

    if (window.Paddle) {
      init();
      return;
    }
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${PADDLE_SRC}"]`);
    const script = existing ?? document.createElement("script");
    if (!existing) {
      script.src = PADDLE_SRC;
      script.async = true;
      document.head.appendChild(script);
    }
    script.addEventListener("load", init);
    return () => {
      cancelled = true;
      script.removeEventListener("load", init);
    };
  }, [txnId, isDone]);

  const message: Record<Status, string> = {
    loading: "Loading checkout…",
    opening: "Opening secure checkout…",
    closed: "You closed the checkout before paying. Your plan is still waiting whenever you are.",
    done: "You're subscribed. You can close this tab and head back to ColdStorage.",
    empty: "No checkout to show. Start your subscription from the ColdStorage app.",
    unconfigured: "Checkout isn't set up yet. Please try again shortly.",
  };

  return (
    <main
      style={{
        minHeight: "100dvh",
        display: "grid",
        placeItems: "center",
        padding: "var(--gutter)",
        background: "var(--bg-app)",
      }}
    >
      <div style={{ textAlign: "center", maxWidth: "44ch" }}>
        <div
          style={{
            font: "700 var(--text-2xl) / 1 var(--font-ui)",
            letterSpacing: "var(--tracking-tighter)",
            color: "var(--text-primary)",
          }}
        >
          ColdStorage
        </div>
        <p style={{ margin: "18px 0 0", font: "var(--type-lead)", color: "var(--text-secondary)", textWrap: "pretty" }}>
          {message[status]}
        </p>
        {status === "closed" && txnId ? (
          <div style={{ marginTop: "18px" }}>
            <Button variant="primary" size="sm" onClick={() => window.Paddle?.Checkout.open({ transactionId: txnId })}>
              Reopen checkout
            </Button>
          </div>
        ) : null}
      </div>
    </main>
  );
}
