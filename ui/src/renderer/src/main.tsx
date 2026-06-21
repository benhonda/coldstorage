/**
 * Renderer entry. Creates the store, wires the controller to `window.coldstore` (exposed by the
 * preload), and mounts React. The controller lives for the lifetime of the window — no teardown here.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { connectController } from "./state/controller.ts";
import { createStore } from "./state/store.ts";

const api = window.coldstore;
const store = createStore();
connectController(api, store);

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <StrictMode>
    <App api={api} store={store} />
  </StrictMode>,
);
