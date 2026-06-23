import type { ColdstoreApi } from "../../../shared/ipc.ts";

/** Fire-and-forget a daemon command, surfacing any rejection to the shell. Threaded into each view. */
export type Exec = (fn: () => Promise<unknown>) => void;

/** Every view gets the typed daemon API and the shared command runner. */
export interface ViewProps {
  api: ColdstoreApi;
  exec: Exec;
}
