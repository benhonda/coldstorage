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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon, IconButton, Modal, Button } from "./ui/primitives.tsx";
import { Sidebar, type NavItem } from "./ui/layout.tsx";
import type { Store } from "./state/store.ts";
import type { ColdstoreApi, ConnectionState, SubscriptionInfo } from "../../shared/ipc.ts";
import type { Exec } from "./views/types.ts";
import { useAppState } from "./useStore.ts";
import { useResizable } from "./ui/useResizable.ts";
import { useFiles } from "./views/files/useFiles.ts";
import { fileFromJournal, isFolderMarker } from "./views/files/model.ts";
import { GettingBackPanel } from "./views/files/GettingBackPanel.tsx";
import { FailuresPanel } from "./views/files/FailuresPanel.tsx";
import type { BlobFailure } from "./state/reducer.ts";
import { bytesAvailable } from "./state/entitlement.ts";
import { MyFilesView } from "./views/MyFilesView.tsx";
import { SettingsView, type SettingsApi, type SettingsTab } from "./views/SettingsView.tsx";
import { SignInView } from "./views/SignInView.tsx";
import { RecoveryCodeShow, RecoveryCodeEnter, VaultGate } from "./views/RecoveryCodeView.tsx";
import { OnboardingWizard, onboardingPending } from "./views/OnboardingWizard.tsx";
import { SubscribeModal, type PaywallReason } from "./views/SubscribeModal.tsx";
import { ChangePlanModal } from "./views/ChangePlanModal.tsx";
import { AccountCard } from "./views/AccountCard.tsx";
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
  // Settings' active subpage, owned here (not in SettingsView) for two reasons: the sidebar chip's
  // popover deep-links to Settings › Account, and the last-visited tab survives a trip to My Files.
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("general");
  const [cmdError, setCmdError] = useState<string | null>(null);
  // The error message the user has dismissed. Daemon `error` events are live state (no id/timestamp), so
  // we gate on the message string: a new, distinct error re-shows the toast; re-firing the same one stays hidden.
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  const [queueOpen, setQueueOpen] = useState(false);
  const [failuresOpen, setFailuresOpen] = useState(false);
  // Null = closed. The reason is load-bearing: the same plan picker is a "you're out of room" block when a
  // free vault fills up, and a plain "pick a plan" when someone upgrades from Settings by choice.
  const [paywallReason, setPaywallReason] = useState<PaywallReason | null>(null);
  const { width: sidebarWidth, onResizeStart } = useResizable("cs-sidebar-width", 232, 200, 360);

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

  // THE deposit gate — is there room for what's being deposited? (see `state/entitlement.ts`). "No
  // subscription" stopped being a reason to refuse a deposit when the free tier landed; only a FULL vault
  // is. "Used" is what's already in S3 (`bytesStored`) PLUS what's mid-upload but not yet counted there
  // (the optimistic "uploading" rows). Without the in-flight half, a burst of deposits all measure against
  // the same stale stored total and every one passes — the vault sails past its quota before it catches up.
  const inFlightBytes = useMemo(
    () => filesApi.files.reduce((sum, f) => (f.status === "uploading" ? sum + f.size : sum), 0),
    [filesApi.files],
  );
  const bytesStored = state.status?.bytesStored ?? null;
  const usedBytes = bytesStored == null ? null : bytesStored + inFlightBytes;
  const roomLeft = bytesAvailable(state.entitlement, usedBytes);
  // Coarse "is there ANY room left" — drives the paywall-reset effect + the retry guard. A specific deposit
  // is checked against its real size via `hasRoomFor` (handed to the browser), which is what stops the one
  // oversized drop a stale stored total would otherwise wave through. Both fail OPEN on unknown usage/quota.
  const canDeposit = roomLeft == null || roomLeft > 0;
  const hasRoomFor = useCallback(
    (incomingBytes: number): boolean => roomLeft == null || incomingBytes <= roomLeft,
    [roomLeft],
  );
  // Which upsell a full vault shows: a free account picks a plan (paywall), a subscriber resizes theirs.
  const subscribed = state.entitlement.active;
  useEffect(() => {
    if (state.entitlement.active) setPaywallReason(null);
  }, [state.entitlement.active]);
  const [overCapacityOpen, setOverCapacityOpen] = useState(false);
  const [changingPlanFromCapacity, setChangingPlanFromCapacity] = useState(false);
  useEffect(() => {
    if (canDeposit) {
      setOverCapacityOpen(false);
      setChangingPlanFromCapacity(false);
    }
  }, [canDeposit]);

  // The live subscription summary (plan badge + Settings manage surface). Refetched on sign-in and
  // whenever the entitlement flips (a checkout just landed / a cancellation took effect). Best-effort:
  // a fetch failure just leaves the badge on its entitlement fallback — never an error surface here.
  const [subscription, setSubscription] = useState<SubscriptionInfo | null>(null);
  const signedIn = state.auth.configured && state.auth.state === "signedIn";

  // Session-local "the wizard's final Continue was clicked" — the fail-open half of onboarding: the
  // server facts are what really end it (onboardingPending), but if the final write failed we still
  // let the user through this session and re-derive next launch. Reset per account.
  const [onboardingDone, setOnboardingDone] = useState(false);
  useEffect(() => setOnboardingDone(false), [state.auth.email]);
  useEffect(() => {
    if (!signedIn) {
      setSubscription(null);
      return;
    }
    let alive = true;
    api
      .getSubscription()
      .then((s) => alive && setSubscription(s))
      .catch(() => alive && setSubscription(null));
    return () => {
      alive = false;
    };
  }, [api, signedIn, state.entitlement.active]);

  const exec: Exec = (fn) => {
    setCmdError(null);
    void fn().catch((e: unknown) => setCmdError(e instanceof Error ? e.message : String(e)));
  };

  // Excludes are daemon-backed now (the SSOT): list comes from the store, add/remove issue commands and
  // the `excludesChanged` refetch reconciles. No local state to drift.
  const settings: SettingsApi = {
    excludes: state.excludes,
    addExclude: (pattern) => exec(() => api.request("addExclude", { pattern })),
    removeExclude: (pattern) => exec(() => api.request("removeExclude", { pattern })),
  };

  const gettingBack = filesApi.files.filter((f) => f.status === "gettingBack");
  const notRunning = NOT_RUNNING[state.connection];

  // Stuck uploads surface here — the ones that won't self-heal on their own: PERMANENT faults, and
  // `overQuota` refusals (they stay stuck until there's room, but a retry lands them once there is).
  // Transient blips stay "uploading" and self-heal, so they don't. Dedup by blob (the event log can record
  // the same blob across runs; newest-first, so first seen wins).
  const stuckFailures = useMemo<BlobFailure[]>(() => {
    const byBlob = new Map<string, BlobFailure>();
    for (const f of state.failures)
      if ((f.kind === "permanent" || f.kind === "overQuota") && !byBlob.has(f.blob)) byBlob.set(f.blob, f);
    return [...byBlob.values()];
  }, [state.failures]);

  const retryFailures = (): void => exec(() => api.request("triggerNow"));
  // Acknowledge-and-clear (renderer state only, no daemon command) — the pill's other exit besides a
  // successful retry (the reducer prunes a failure when its blob later archives). File rows keep their ⚠.
  const dismissFailures = (): void => store.dispatch({ type: "failuresDismissed" });

  // A quota refusal from the DAEMON opens the SAME paywall the client gate would have — so the experience is
  // identical whichever layer catches an over-quota deposit. This is the fail-open path: a drop slipped past
  // the client gate while its inputs were still null (e.g. the first seconds after launch, before entitlement
  // + usage land) and the daemon caught it, or the background auto-run hit the ceiling. Without this, those
  // refusals only showed a "couldn't upload" row, never the upsell. Deduped by blob via a ref, so a refusal
  // retried across auto-run passes doesn't re-pop after the user has dismissed it; a genuinely new blob does.
  const shownQuotaBlocks = useRef<Set<string>>(new Set());
  useEffect(() => {
    const fresh = state.failures.some((f) => f.kind === "overQuota" && !shownQuotaBlocks.current.has(f.blob));
    if (!fresh) return;
    for (const f of state.failures) if (f.kind === "overQuota") shownQuotaBlocks.current.add(f.blob);
    if (subscribed) setOverCapacityOpen(true);
    else setPaywallReason("quotaReached");
  }, [state.failures, subscribed]);

  const footer = (
    <>
      {notRunning && (
        <div className="cs-status">
          <span className={`cs-dot cs-dot--${state.connection}`} />
          {notRunning}
        </div>
      )}
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
    // Existing account on a NEW device: recovery-code entry comes before anything else (the wizard is
    // for first-run setup; a device handoff isn't one — though an unfinished account will still get
    // the wizard's remaining steps right after this unlock).
    if (v.state === "needsRecoveryCode") {
      return <RecoveryCodeEnter email={email} onSubmit={(code) => api.submitRecoveryCode(code)} onSignOut={signOut} />;
    }
    // The first-run wizard — active while the account still owes onboarding facts (name, tour,
    // confirmed recovery code). Fails OPEN: if the account fetch never landed (`known: false`), the
    // wizard stays out of the way and the plain vault gates below carry the session.
    if (!onboardingDone && onboardingPending(state.account)) {
      return (
        <OnboardingWizard
          api={api}
          auth={state.auth}
          vault={v}
          account={state.account}
          quotaBytes={state.entitlement.quotaBytes}
          subscribed={subscribed}
          onSignOut={signOut}
          onDone={() => setOnboardingDone(true)}
        />
      );
    }
    // Fallback (account facts unknown — e.g. the account server was unreachable while a fresh mint
    // still produced a one-time code): the pre-wizard behavior, so the code is never lost unseen.
    if (v.recoveryCode) {
      return (
        <RecoveryCodeShow
          code={v.recoveryCode}
          email={email}
          onAcknowledge={() => {
            void api.acknowledgeRecoveryCode();
            void api.confirmRecoveryCode().catch(() => undefined);
          }}
          onSignOut={signOut}
        />
      );
    }
    if (v.state !== "unlocked") {
      return <VaultGate state={v.state} error={v.error} email={email} onSignOut={signOut} />;
    }
  }

  return (
    <div className="cs-shell" style={{ gridTemplateColumns: `${sidebarWidth}px 1fr` }}>
      <Sidebar
        items={NAV}
        active={route}
        onNavigate={(id) => isRoute(id) && setRoute(id)}
        footer={footer}
        account={
          signedIn && state.auth.email ? (
            <AccountCard
              email={state.auth.email}
              displayName={state.account.displayName}
              subscription={subscription}
              active={state.entitlement.active}
              usedBytes={usedBytes}
              quotaBytes={state.entitlement.quotaBytes}
              onOpenSettings={() => {
                setSettingsTab("account");
                setRoute("settings");
              }}
              onSignOut={() => void api.signOut()}
            />
          ) : undefined
        }
      />
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
        <FailuresPanel
          failures={stuckFailures}
          onRetry={retryFailures}
          onDismiss={dismissFailures}
          onClose={() => setFailuresOpen(false)}
        />
      )}

      {route === "files" && (
        <MyFilesView
          api={api}
          exec={exec}
          files={filesApi.files}
          virtualFolders={filesApi.virtualFolders}
          filesApi={filesApi}
          run={state.run}
          hasRoomFor={hasRoomFor}
          onDepositBlocked={() => (subscribed ? setOverCapacityOpen(true) : setPaywallReason("quotaReached"))}
        />
      )}
      {route === "settings" && (
        <SettingsView
          api={api}
          exec={exec}
          sources={state.status?.sources ?? []}
          running={state.run?.active ?? false}
          settings={settings}
          bytesStored={state.status?.bytesStored ?? null}
          files={filesApi.files}
          virtualFolders={filesApi.virtualFolders}
          auth={state.auth}
          account={state.account}
          entitlement={state.entitlement}
          onSubscribe={() => setPaywallReason("upgrade")}
          subscription={subscription}
          onSubscriptionChanged={setSubscription}
          tab={settingsTab}
          onTabChange={setSettingsTab}
        />
      )}

      {paywallReason && (
        <SubscribeModal
          api={api}
          reason={paywallReason}
          entitlement={state.entitlement}
          onSubscribe={(priceId) => void api.subscribe(priceId)}
          onClose={() => setPaywallReason(null)}
        />
      )}

      {/* Out of room on a PAID plan — the free-tier equivalent is the plan picker above (nothing to resize
          yet). Already a customer, just at their plan's cap. Plain, factual, no alarm; offers the way out. */}
      {overCapacityOpen && !changingPlanFromCapacity && (
        <Modal
          title="Storage full"
          icon="database"
          onClose={() => setOverCapacityOpen(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setOverCapacityOpen(false)}>
                Not now
              </Button>
              {subscription && (
                <Button variant="primary" onClick={() => setChangingPlanFromCapacity(true)}>
                  Change plan
                </Button>
              )}
            </>
          }
        >
          <p>
            You&apos;ve used all of your plan&apos;s storage. Free up space, or upgrade your plan to keep
            backing up.
          </p>
        </Modal>
      )}
      {changingPlanFromCapacity && subscription && (
        <ChangePlanModal
          api={api}
          current={subscription}
          bytesStored={state.status?.bytesStored ?? null}
          onChanged={(sub) => {
            setSubscription(sub);
            setChangingPlanFromCapacity(false);
            setOverCapacityOpen(false);
          }}
          onClose={() => setChangingPlanFromCapacity(false)}
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
