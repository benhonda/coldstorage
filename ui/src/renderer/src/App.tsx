/**
 * Layer-3 shell — the reorganizable-filesystem design. Two surfaces: **My Files** (the drive: browse,
 * deposit, reorganize, request-back) and **Settings** (the rules). The renderer is a pure consumer of
 * `window.coldstore` (commands) + the folded store (event-driven state); no archive logic here.
 *
 * App owns the cross-view state: the file tree ({@link useFiles}, overlaying live restore status from
 * the store) and daemon-backed settings (excludes from the store, mutated via commands). It threads slices to the two views, keeps the
 * shared `exec` command runner (surfaces rejections as a toast), and pins the foot of the sidebar: a
 * plain storage line, a quiet status line only when the background uploader isn't running, and a
 * clickable getting-back indicator that opens the restore queue.
 */
import { useEffect, useMemo, useState } from "react";
import { Icon, IconButton } from "./ui/primitives.tsx";
import { Sidebar, type NavItem } from "./ui/layout.tsx";
import type { Store } from "./state/store.ts";
import type { ColdstoreApi, ConnectionState } from "../../shared/ipc.ts";
import type { Exec } from "./views/types.ts";
import { useAppState } from "./useStore.ts";
import { useResizable } from "./ui/useResizable.ts";
import { useFiles } from "./views/files/useFiles.ts";
import { fileFromJournal, isFolderMarker, formatBytes, totalBytes } from "./views/files/model.ts";
import { GettingBackPanel } from "./views/files/GettingBackPanel.tsx";
import { FailuresPanel } from "./views/files/FailuresPanel.tsx";
import type { BlobFailure } from "./state/reducer.ts";
import { MyFilesView } from "./views/MyFilesView.tsx";
import { SettingsView, type SettingsApi } from "./views/SettingsView.tsx";
import { SignInView } from "./views/SignInView.tsx";
import { RecoveryCodeShow, RecoveryCodeEnter, VaultGate } from "./views/RecoveryCodeView.tsx";
import { SubscribeModal } from "./views/SubscribeModal.tsx";
import { UpdateBanner } from "./views/UpdateBanner.tsx";

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
  // The error message the user has dismissed. Daemon `error` events are live state (no id/timestamp), so
  // we gate on the message string: a new, distinct error re-shows the toast; re-firing the same one stays hidden.
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  const [queueOpen, setQueueOpen] = useState(false);
  const [failuresOpen, setFailuresOpen] = useState(false);
  const [paywallOpen, setPaywallOpen] = useState(false);
  const { width: sidebarWidth, onResizeStart } = useResizable("cs-sidebar-width", 232, 200, 360);

  // Deposit gate (Phase 5c): only a signed-in (configured) user whose subscription we've CONFIRMED
  // inactive is gated — dogfood mode and the pre-first-check window stay open (the real enforcement is
  // the later hard gate; this is the soft app-side one). Close the paywall the moment a sub goes active.
  const canDeposit = !state.auth.configured || !state.entitlement.known || state.entitlement.active;
  useEffect(() => {
    if (state.entitlement.active) setPaywallOpen(false);
  }, [state.entitlement.active]);

  const exec: Exec = (fn) => {
    setCmdError(null);
    void fn().catch((e: unknown) => setCmdError(e instanceof Error ? e.message : String(e)));
  };

  // Cross-view state: the file tree (daemon `listFiles`, mapped to the browser model; live restore
  // status overlaid inside useFiles) + local settings.
  // Folder markers (empty-folder anchors) aren't files — split them out and feed their paths into useFiles'
  // virtualFolders channel, so an empty folder persists across reloads while the tree derivation stays simple.
  const daemonFiles = useMemo(() => state.files.filter((r) => !isFolderMarker(r)).map(fileFromJournal), [state.files]);
  const persistedFolders = useMemo(
    () => state.files.filter(isFolderMarker).map((r) => r.relativePath),
    [state.files],
  );
  const filesApi = useFiles(daemonFiles, persistedFolders, state.restores);
  // Excludes are daemon-backed now (the SSOT): list comes from the store, add/remove issue commands and
  // the `excludesChanged` refetch reconciles. No local state to drift.
  const settings: SettingsApi = {
    excludes: state.excludes,
    addExclude: (pattern) => exec(() => api.request("addExclude", { pattern })),
    removeExclude: (pattern) => exec(() => api.request("removeExclude", { pattern })),
  };

  const vaultBytes = totalBytes(filesApi.files);
  const gettingBack = filesApi.files.filter((f) => f.status === "gettingBack");
  const notRunning = NOT_RUNNING[state.connection];

  // Only PERMANENT (stuck) failures surface — transient blips stay "uploading" and self-heal. Dedup by
  // blob (the event log can record the same blob across runs; newest-first, so first seen wins).
  const stuckFailures = useMemo<BlobFailure[]>(() => {
    const byBlob = new Map<string, BlobFailure>();
    for (const f of state.failures) if (f.kind === "permanent" && !byBlob.has(f.blob)) byBlob.set(f.blob, f);
    return [...byBlob.values()];
  }, [state.failures]);

  const retryFailures = (): void => exec(() => api.request("triggerNow"));

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
      {stuckFailures.length > 0 && (
        // Persistent (not a toast — a toast was missed): a stuck-upload count, click → the failures panel.
        // PLACEHOLDER copy — Ben to finalize.
        <button
          type="button"
          className="cs-failed"
          onClick={(e) => {
            e.stopPropagation();
            setFailuresOpen((v) => !v);
          }}
        >
          <Icon name="error" size={16} />
          {stuckFailures.length} couldn&apos;t upload
        </button>
      )}
    </>
  );

  // Most recent of the two error channels (command rejection over live daemon error), hidden once dismissed.
  const liveError = cmdError ?? state.lastError;
  const toast = liveError && liveError !== dismissedError ? liveError : null;
  const dismissToast = (): void => {
    setCmdError(null);
    setDismissedError(liveError);
  };

  // Startup: show a neutral "checking…" card until we actually know the sign-in state, rather than
  // flashing the shell or the login screen and then correcting it. Two windows: `initializing` (before
  // main's first status push arrives) and `auth.state === "restoring"` (main IS checking a saved session
  // — a returning user must not flash past "Continue with Google"). After every hook above, so the hook
  // order is identical across renders.
  if (state.initializing || state.auth.state === "restoring") {
    return (
      <SignInView
        auth={state.auth}
        onSignIn={() => {}}
        onEmailStart={() => Promise.resolve()}
        onEmailSubmit={() => Promise.resolve()}
        onEmailCancel={() => {}}
        checking
      />
    );
  }

  // Sign-in + vault gates (Phase 5): a configured (multi-user) install shows the shell only once the
  // user is signed in AND the zero-knowledge vault is unlocked — uploads have no per-user prefix without
  // a user, and no encryption key without an unlocked vault. Dogfood mode (unconfigured) never sees any
  // of this. After every hook above, so the hook order is identical with and without a gate.
  if (state.auth.configured) {
    if (state.auth.state !== "signedIn") {
      return (
        <SignInView
          auth={state.auth}
          onSignIn={() => void api.signIn()}
          onEmailStart={(email) => api.startEmailSignIn(email)}
          onEmailSubmit={(code) => api.submitEmailCode(code)}
          onEmailCancel={() => void api.cancelEmailSignIn()}
        />
      );
    }
    const v = state.vault;
    const email = state.auth.email;
    const signOut = (): void => void api.signOut();
    // The one-time recovery code (fresh signup) takes precedence — show it before anything else.
    if (v.recoveryCode) {
      return (
        <RecoveryCodeShow
          code={v.recoveryCode}
          email={email}
          onAcknowledge={() => void api.acknowledgeRecoveryCode()}
          onSignOut={signOut}
        />
      );
    }
    if (v.state === "needsRecoveryCode") {
      return <RecoveryCodeEnter email={email} onSubmit={(code) => api.submitRecoveryCode(code)} onSignOut={signOut} />;
    }
    if (v.state !== "unlocked") {
      return <VaultGate state={v.state} error={v.error} email={email} onSignOut={signOut} />;
    }
  }

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

      {failuresOpen && stuckFailures.length > 0 && (
        <FailuresPanel failures={stuckFailures} onRetry={retryFailures} onClose={() => setFailuresOpen(false)} />
      )}

      {route === "files" && (
        <MyFilesView
          api={api}
          exec={exec}
          files={filesApi.files}
          virtualFolders={filesApi.virtualFolders}
          filesApi={filesApi}
          pricing={state.pricing}
          uploadProgress={state.run?.uploadProgress ?? {}}
          canDeposit={canDeposit}
          onDepositBlocked={() => setPaywallOpen(true)}
        />
      )}
      {route === "settings" && (
        <SettingsView
          api={api}
          exec={exec}
          sources={state.status?.sources ?? []}
          running={state.run?.active ?? false}
          settings={settings}
          pricing={state.pricing}
          vaultBytes={vaultBytes}
          files={filesApi.files}
          virtualFolders={filesApi.virtualFolders}
          auth={state.auth}
          entitlement={state.entitlement}
          onSubscribe={() => setPaywallOpen(true)}
        />
      )}

      {paywallOpen && (
        <SubscribeModal
          entitlement={state.entitlement}
          onSubscribe={() => void api.subscribe()}
          onClose={() => setPaywallOpen(false)}
        />
      )}

      <UpdateBanner update={state.update} onRestart={() => void api.restartToUpdate()} />

      {toast && (
        <div className="cs-toast" role="alert">
          <Icon name="error" size={20} />
          <span className="cs-toast-msg">{toast}</span>
          {/* Recovery for a denied/limited Photos grant — jumps straight to the right Settings pane (the daemon
              can't re-prompt once denied). Only on the live daemon-error channel, not a command rejection. */}
          {!cmdError && state.lastErrorCode === "photosAccessDenied" && (
            <button type="button" className="cs-toast-action" onClick={() => void api.openPhotosSettings()}>
              Open Photos settings
            </button>
          )}
          <IconButton icon="close" label="Dismiss" onClick={dismissToast} />
        </div>
      )}
    </div>
  );
};
