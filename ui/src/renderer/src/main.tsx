/**
 * Renderer entry. Creates the store, wires the controller to `window.coldstore` (exposed by the
 * preload), and mounts React. The controller lives for the lifetime of the window — no teardown here.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// Self-hosted faces — bundled as same-origin assets so they load under the renderer's locked-down
// CSP (default-src 'self'). Family names match the DS typography tokens ("Hanken Grotesk", etc.).
import "@fontsource/hanken-grotesk/400.css";
import "@fontsource/hanken-grotesk/500.css";
import "@fontsource/hanken-grotesk/600.css";
import "@fontsource/hanken-grotesk/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/600.css";
import "material-symbols/rounded.css";
import "./styles/index.css";
import { App } from "./App.tsx";
import { ToastProvider } from "./ui/toast.tsx";
import { connectController } from "./state/controller.ts";
import { createStore } from "./state/store.ts";
import { applyDensity, readDensity } from "./ui/density.ts";

// Before the first paint, so the app never renders comfortable and snaps compact a frame later.
applyDensity(readDensity());

const api = window.coldstore;
const store = createStore();
const controller = connectController(api, store);

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <StrictMode>
    {/* Outside App, not inside it: App returns early for the sign-in, vault and onboarding gates, and a
        toast raised on the way through one of those still has to be able to render. */}
    <ToastProvider>
      <App api={api} store={store} retryFiles={controller.refreshFiles} retryDeposits={controller.refreshDeposits} />
    </ToastProvider>
  </StrictMode>,
);
