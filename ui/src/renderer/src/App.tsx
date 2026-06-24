/**
 * Layer-3 shell — the reorganizable-filesystem design. Two surfaces: **My Files** (the drive: browse,
 * deposit, reorganize, request-back) and **Settings** (the rules). The renderer is a pure consumer of
 * `window.coldstore` (commands) + the folded store (event-driven state); no archive logic here.
 *
 * App owns the cross-view state: the file tree ({@link useFiles}, overlaying live restore status from
 * the store) and local settings ({@link useSettings}). It threads slices to the two views, keeps the
 * shared `exec` command runner (surfaces rejections as a toast), and pins the foot of the sidebar: a
 * plain storage line, a quiet status line only when the background uploader isn't running, and a
 * clickable getting-back indicator that opens the restore queue.
 */
import { useState } from "react";
import { Icon, IconButton } from "./ui/primitives.tsx";
import { Sidebar, type NavItem } from "./ui/layout.tsx";
import type { Store } from "./state/store.ts";
import type { ColdstoreApi, ConnectionState } from "../../shared/ipc.ts";
import type { Exec } from "./views/types.ts";
import { useAppState } from "./useStore.ts";
import { useResizable } from "./ui/useResizable.ts";
import { useFiles } from "./views/files/useFiles.ts";
import { useSettings } from "./views/files/useSettings.ts";
import { formatBytes, totalBytes } from "./views/files/model.ts";
import { GettingBackPanel } from "./views/files/GettingBackPanel.tsx";
import { MyFilesView } from "./views/MyFilesView.tsx";
import { SettingsView } from "./views/SettingsView.tsx";

/** Plain status when the background uploader isn't connected — no "daemon" jargon, quiet when healthy. */
const NOT_RUNNING: Partial<Record<ConnectionState, string>> = {
  connecting: "Connecting…",
  disconnected: "Not running",
};

type Route = "files" | "settings";

const NAV: NavItem[] = [
  { id: "files", label: "My Files", icon: "folder" },
  { id: "settings", label: "Settings", icon: "settings" },
];

const isRoute = (id: string): id is Route => id === "files" || id === "settings";

interface Props {
  api: ColdstoreApi;
  store: Store;
}

export const App = ({ api, store }: Props): React.JSX.Element => {
  const state = useAppState(store);
  const [route, setRoute] = useState<Route>("files");
  const [cmdError, setCmdError] = useState<string | null>(null);
  const [queueOpen, setQueueOpen] = useState(false);
  const { width: sidebarWidth, onResizeStart } = useResizable("cs-sidebar-width", 232, 200, 360);

  const exec: Exec = (fn) => {
    setCmdError(null);
    void fn().catch((e: unknown) => setCmdError(e instanceof Error ? e.message : String(e)));
  };

  // Cross-view state: the file tree (live restore status overlaid) + local settings.
  const filesApi = useFiles(state.restores);
  const settings = useSettings();

  const vaultBytes = totalBytes(filesApi.files);
  const gettingBack = filesApi.files.filter((f) => f.status === "gettingBack");
  const notRunning = NOT_RUNNING[state.connection];

  const footer = (
    <>
      {notRunning && (
        <div className="cs-status">
          <span className={`cs-dot cs-dot--${state.connection}`} />
          {notRunning}
        </div>
      )}
      <div className="cs-store">
        <Icon name="cloud_done" size={16} />
        {formatBytes(vaultBytes)} stored
      </div>
      {gettingBack.length > 0 && (
        <button
          type="button"
          className="cs-getting"
          onClick={(e) => {
            e.stopPropagation();
            setQueueOpen((v) => !v);
          }}
        >
          <Icon name="hourglass_top" size={16} />
          Transferring {gettingBack.length}
        </button>
      )}
    </>
  );

  // Most recent of the two error channels; the user can dismiss the command one (daemon `error` events
  // reflect live state, so they clear when the next event arrives).
  const toast = cmdError ?? state.lastError;

  return (
    <div className="cs-shell" style={{ gridTemplateColumns: `${sidebarWidth}px 1fr` }}>
      <Sidebar items={NAV} active={route} onNavigate={(id) => isRoute(id) && setRoute(id)} footer={footer} />
      <div
        className="cs-resizer"
        style={{ left: sidebarWidth }}
        onPointerDown={onResizeStart}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
      />

      {queueOpen && gettingBack.length > 0 && (
        <GettingBackPanel files={gettingBack} restores={state.restores} onClose={() => setQueueOpen(false)} />
      )}

      {route === "files" && (
        <MyFilesView
          api={api}
          exec={exec}
          files={filesApi.files}
          virtualFolders={filesApi.virtualFolders}
          filesApi={filesApi}
        />
      )}
      {route === "settings" && (
        <SettingsView
          api={api}
          exec={exec}
          sources={state.status?.sources ?? []}
          status={state.status}
          settings={settings}
          vaultBytes={vaultBytes}
        />
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
