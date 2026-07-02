/**
 * Dev-only loopback redirect listener. An UNPACKAGED Electron on macOS can't receive custom-scheme
 * deep links (the running Electron.app's Info.plist has no `coldstorage` scheme — registration is
 * build-time), so `task ui:dev` sign-in redirects to http://localhost:53682/auth/callback instead:
 * a throwaway one-shot server, bound to 127.0.0.1, alive for exactly one sign-in attempt. The
 * packaged app never starts this — it gets the real `open-url` deep link.
 */
import { createServer } from "node:http";

export const LOOPBACK_PORT = 53682;
/** Registered verbatim on the Cognito app client (cognito.tf `app_oauth_callback_urls`). */
export const LOOPBACK_REDIRECT_URI = `http://localhost:${LOOPBACK_PORT}/auth/callback`;

/** Shown in the browser tab after the redirect lands. Deliberately plain — at this point the app is
 * still exchanging the code, so this only hands the user back. */
const PAGE = `<!doctype html><meta charset="utf-8"><title>ColdStorage</title>
<body style="font-family: system-ui; display: grid; place-items: center; height: 100vh; margin: 0">
<p>You can close this tab and go back to ColdStorage.</p></body>`;

/**
 * Listen for the one redirect. `onUrl` receives the full callback URL (same shape the deep-link path
 * delivers, so the manager handles both identically); the server closes itself after serving it.
 * The returned `stop` closes early — a superseding sign-in attempt or app quit.
 *
 * `ready` MUST be awaited before opening the browser: if the port can't be bound (EADDRINUSE — in
 * practice a VS Code devcontainer port-forward squatting 127.0.0.1:53682 on the host, bitten
 * 2026-07-02), the sign-in has to fail loudly UP FRONT. Opening the browser anyway sends the user
 * through Google into a redirect that black-holes against whoever owns the port.
 */
export const awaitLoopbackCallback = (onUrl: (url: string) => void): { stop: () => void; ready: Promise<void> } => {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${LOOPBACK_PORT}`);
    if (url.pathname !== "/auth/callback") {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(PAGE);
    server.close();
    onUrl(url.toString());
  });
  const ready = new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", (e) => reject(e instanceof Error ? e : new Error(String(e))));
  });
  server.listen(LOOPBACK_PORT, "127.0.0.1");
  return { stop: () => server.close(), ready };
};
