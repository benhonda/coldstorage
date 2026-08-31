import type { Route } from "./+types/desktop.auth.($variant)";
import * as React from "react";
import { data } from "react-router";
import { Button } from "~/components/ds/button";

/**
 * The desktop app's browser landing pages. Cognito can't redirect from an IdP straight to a custom
 * scheme without leaving the browser stranded on a dead Google/Cognito page (and the "open
 * ColdStorage?" OS prompt fires from a page the user has no reason to trust), so the app's OAuth
 * callback and logout URLs point HERE instead — a page we own that hands off to the app and tells
 * the user they're done (PILLAR5). Three registered URLs, one file:
 *
 * - `/desktop/auth`          → relays ?code/&state (or ?error) to `coldstorage://auth/callback`
 * - `/desktop/auth/staging`  → same, to `coldstorage-staging://auth/callback` (the dogfood build)
 * - `/desktop/auth/signed-out` → the `/logout` landing; nothing to relay, the app already reset
 *
 * Each must byte-match a registered Cognito URL (infra `app_oauth_callback_urls` /
 * `app_signout_url`) AND the app's `redirectUri` (ui `relayRedirectUri` — the token exchange sends
 * the same string). The relay forwards the query verbatim: the app's existing state-nonce check is
 * the CSRF/duplicate guard, and error callbacks (user cancelled at Google) surface in-app the same
 * way they always did.
 */

const SCHEMES = { prod: "coldstorage", staging: "coldstorage-staging" } as const;

export function meta() {
  return [
    { title: "ColdStorage" },
    // Transactional hand-off pages — keep them out of search results.
    { name: "robots", content: "noindex" },
  ];
}

export function loader({ params }: Route.LoaderArgs) {
  const v = params.variant;
  if (v === undefined) return { kind: "relay" as const, scheme: SCHEMES.prod };
  if (v === "staging") return { kind: "relay" as const, scheme: SCHEMES.staging };
  if (v === "signed-out") return { kind: "signedOut" as const, scheme: null };
  throw data(null, { status: 404 });
}

export default function DesktopAuth({ loaderData }: Route.ComponentProps) {
  const { kind, scheme } = loaderData;
  // Built client-side from the live query string — the relay must carry ?code&state (or ?error)
  // through untouched. Null until hydration and on the signed-out page.
  const [deepLink, setDeepLink] = React.useState<string | null>(null);
  const [isError, setIsError] = React.useState(false);

  React.useEffect(() => {
    if (kind !== "relay" || scheme === null) return;
    const search = window.location.search;
    setIsError(new URLSearchParams(search).has("error"));
    const link = `${scheme}://auth/callback${search}`;
    setDeepLink(link);
    // The automatic hand-off. `replace` keeps this page out of history so Back doesn't re-fire it.
    window.location.replace(link);
  }, [kind, scheme]);

  const heading = kind === "signedOut" ? "You're signed out" : isError ? "Heading back to ColdStorage" : "You're signed in";
  const body =
    kind === "signedOut"
      ? "ColdStorage has signed you out on this Mac. You can close this tab."
      : "ColdStorage should open on its own. If it doesn't, the button below will do it - either way, you can close this tab after.";

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
          {heading}
        </div>
        <p style={{ margin: "18px 0 0", font: "var(--type-lead)", color: "var(--text-secondary)", textWrap: "pretty" }}>
          {body}
        </p>
        {deepLink !== null ? (
          <div style={{ marginTop: "18px" }}>
            <Button variant="primary" size="sm" href={deepLink}>
              Open ColdStorage
            </Button>
          </div>
        ) : null}
      </div>
    </main>
  );
}
