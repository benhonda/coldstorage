/**
 * Layer-3 shell. The renderer is a pure consumer of `window.coldstore` (commands) and the folded
 * store (event-driven state) — no archive logic here. App owns only view routing + a shared command
 * runner (`exec`) that surfaces command rejections; daemon-pushed `error` events fold into
 * `state.lastError`. Both render as a calm, dismissable toast. Views skin the store with the DS.
 */
import { useState } from "react";
import { Icon, IconButton } from "./ui/primitives.tsx";
import { Sidebar, type NavItem } from "./ui/layout.tsx";
import type { Store } from "./state/store.ts";
import type { ColdstoreApi } from "../../shared/ipc.ts";
import type { Exec } from "./views/types.ts";
import { useAppState } from "./useStore.ts";
import { VaultView } from "./views/VaultView.tsx";
import { SourcesView } from "./views/SourcesView.tsx";
import { RestoreView } from "./views/RestoreView.tsx";

type Route = "vault" | "sources" | "restore";

const NAV: NavItem[] = [
  { id: "vault", label: "Vault", icon: "ac_unit" },
  { id: "sources", label: "Sources", icon: "folder" },
  { id: "restore", label: "Restore", icon: "cloud_download" },
  // Browse is blocked on the R2 index (infra not scaffolded) — shown disabled, not hidden.
  { id: "browse", label: "Browse", icon: "photo_library", disabled: true, hint: "Available once your vault index is ready" },
];

const isRoute = (id: string): id is Route =>
  id === "vault" || id === "sources" || id === "restore";

interface Props {
  api: ColdstoreApi;
  store: Store;
}

export const App = ({ api, store }: Props): React.JSX.Element => {
  const state = useAppState(store);
  const [route, setRoute] = useState<Route>("vault");
  const [cmdError, setCmdError] = useState<string | null>(null);

  const exec: Exec = (fn) => {
    setCmdError(null);
    void fn().catch((e: unknown) => setCmdError(e instanceof Error ? e.message : String(e)));
  };

  const { connection, status, run, failures, restores, lastError } = state;
  // Most recent of the two error channels; the user can dismiss the command one (daemon errors
  // clear when the next event arrives — they reflect live state, not a transient action failure).
  const toast = cmdError ?? lastError;

  return (
    <div className="cs-shell">
      <Sidebar items={NAV} active={route} onNavigate={(id) => isRoute(id) && setRoute(id)} connection={connection} />

      {route === "vault" && (
        <VaultView api={api} exec={exec} status={status} run={run} failures={failures} />
      )}
      {route === "sources" && (
        <SourcesView api={api} exec={exec} sources={status?.sources ?? []} />
      )}
      {route === "restore" && (
        <RestoreView api={api} exec={exec} activities={Object.values(restores)} />
      )}

      {toast && (
        <div className="cs-toast" role="alert">
          <Icon name="error" size={20} />
          <span className="cs-toast-msg">{toast}</span>
          {cmdError && <IconButton icon="close" label="Dismiss" onClick={() => setCmdError(null)} />}
        </div>
      )}
    </div>
  );
};
