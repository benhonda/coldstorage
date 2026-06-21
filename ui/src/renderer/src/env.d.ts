/// <reference types="vite/client" />
import type { ColdstoreApi } from "../../shared/ipc.ts";

declare global {
  interface Window {
    /** The narrow daemon surface the preload exposes via contextBridge. */
    coldstore: ColdstoreApi;
  }
}
