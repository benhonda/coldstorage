import type { Route } from "./+types/($lang).checkout";
import * as React from "react";
import { useSearchParams } from "react-router";

/**
 * Checkout page (Phase 3). Re-homed from the account-backend's brandless HTML page.
 *
 * Paddle Billing has no Paddle-hosted checkout: `transactions.create` returns a
 * `checkout.url` = the account's default payment link with `?_ptxn=<txn_id>` appended, and
 * THIS page's Paddle.js detects `_ptxn` and auto-opens the overlay. So the Paddle dashboard's
 * default-payment-link must point at `<this site>/checkout` (Phase 4 / Ben repoints it from
 * the account-backend URL). The authenticated transaction is still created server-side in
 * account-backend (`checkout-session`) — this page only opens the overlay.
 */
export function meta() {
  return [
    { title: "ColdStorage checkout" },
    // Transactional page — keep it out of search results.
    { name: "robots", content: "noindex" },
  ];
}

// Minimal Paddle.js surface we use (avoids `any`; the CDN script defines the rest).
type PaddleJS = {
  Environment?: { set: (env: string) => void };
  Initialize: (opts: { token: string }) => void;
};
declare global {
  interface Window {
    Paddle?: PaddleJS;
  }
}

const PADDLE_SRC = "https://cdn.paddle.com/paddle/v2/paddle.js";

type Status = "loading" | "opening" | "empty" | "unconfigured";

export default function Checkout() {
  const [params] = useSearchParams();
  const hasTxn = params.has("_ptxn");
  const [status, setStatus] = React.useState<Status>("loading");

  React.useEffect(() => {
    const token = window.env?.PUBLIC_PADDLE_CLIENT_TOKEN;
    const environment = window.env?.PUBLIC_PADDLE_ENVIRONMENT ?? "sandbox";

    if (!token) {
      setStatus("unconfigured");
      return;
    }
    // No transaction in the URL → someone hit /checkout directly; nothing to sell.
    if (!hasTxn) {
      setStatus("empty");
      return;
    }

    let cancelled = false;
    const init = () => {
      const Paddle = window.Paddle;
      if (!Paddle || cancelled) return;
      if (environment === "sandbox") Paddle.Environment?.set("sandbox");
      // Paddle.js auto-opens the overlay checkout for the ?_ptxn=<txn_id> in the URL.
      Paddle.Initialize({ token });
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
  }, [hasTxn]);

  const message: Record<Status, string> = {
    loading: "Loading checkout…",
    opening: "Opening secure checkout…",
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
      </div>
    </main>
  );
}
