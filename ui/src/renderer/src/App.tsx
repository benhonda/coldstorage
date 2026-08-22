/**
 * Layer-3 shell — the reorganizable-filesystem design. Two surfaces: **My Files** (the drive: browse,
 * deposit, reorganize, request-back) and **Settings** (the rules). The renderer is a pure consumer of
 * `window.coldstore` (commands) + the folded store (event-driven state); no archive logic here.
 *
 * App owns the cross-view state: the file tree ({@link useFiles}, overlaying transfer status from the
 * store's daemon-backed `restores` list) and daemon-backed settings (excludes from the store, mutated via
 * commands). It threads slices to the three views, keeps the shared `exec` command runner (surfaces
 * rejections as a toast), and pins the foot of the sidebar: a quiet status line only when the background
 * uploader isn't running, and the stuck-uploads pill.
 *
 * In-flight downloads used to live down there too, as a count + popover. They now have their own page —
 * a count in the sidebar foot with a popover hanging off it had nowhere to send anyone, and it was built
 * from renderer memory, so it lost the user's downloads on sign-out.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon, Modal, Button } from "./ui/primitives.tsx";
import { Sidebar, type NavItem } from "./ui/layout.tsx";
import { useToast } from "./ui/toast.tsx";
import type { Store } from "./state/store.ts";
import type { ColdstoreApi, ConnectionState, SubscriptionInfo } from "../../shared/ipc.ts";
import { isActiveRestore } from "../../shared/ipc.ts";
import type { Exec } from "./views/types.ts";
import { useAppState } from "./useStore.ts";
import { useResizable } from "./ui/useResizable.ts";
import { useFiles } from "./views/files/useFiles.ts";
import { fileFromJournal, isFolderMarker, isUploadOutstanding } from "./views/files/model.ts";
import { FailuresPanel } from "./views/files/FailuresPanel.tsx";
import { eventAction, type BlobFailure } from "./state/reducer.ts";
import { bytesAvailable } from "./state/entitlement.ts";
import { MyFilesView } from "./views/MyFilesView.tsx";
import { SettingsView, type SettingsApi, type SettingsTab } from "./views/SettingsView.tsx";
import { DownloadsView } from "./views/DownloadsView.tsx";
import { groupDownloads } from "./views/downloads/model.ts";
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

type Route = "files" | "downloads" | "settings";

const ROUTES: readonly Route[] = ["files", "downloads", "settings"];

const isRoute = (id: string): id is Route => (ROUTES as readonly string[]).includes(id);

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
  const toast = useToast();
  const [failuresOpen, setFailuresOpen] = useState(false);
  // Set by the Downloads page to send the user back to My Files with the request dialog open for these
  // files — the way out of a download that needs re-buying (unpaid, or its thaw window lapsed). A LIST
  // because a grouped row re-asks every file that needs re-buying in one go. Cleared by MyFilesView once
  // it has opened the dialog, so the same files can be asked for again later.
  const [requestFileIds, setRequestFileIds] = useState<string[] | null>(null);
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
  // The daemon's own "how long is too quiet?" window. `Infinity` until a snapshot arrives (startup, or a
  // dropped connection): with no idea how often the daemon promised to look, silence proves nothing, so
  // nothing gets called stale on the strength of not having asked.
  const staleAfter = state.status?.staleAfterSeconds ?? Infinity;
  const filesApi = useFiles(daemonFiles, persistedFolders, state.restores, staleAfter);

  // THE deposit gate — is there room for what's being deposited? (see `state/entitlement.ts`). "No
  // subscription" stopped being a reason to refuse a deposit when the free tier landed; only a FULL vault
  // is. "Used" is what's already in S3 (`bytesStored`) PLUS what's mid-upload but not yet counted there
  // (the optimistic "uploading" rows). Without the in-flight half, a burst of deposits all measure against
  // the same stale stored total and every one passes — the vault sails past its quota before it catches up.
  // `isUploadOutstanding`, not `=== "uploading"`: a STALLED upload is still queued work whose bytes are
  // still coming (the journal has it `planned` and the loop keeps retrying). Counting only the healthy ones
  // would drop stalled files out of the quota and let the vault sail past its limit — the precise failure
  // the paragraph above describes, reintroduced by a status the gate didn't know about.
  const inFlightBytes = useMemo(
    () => filesApi.files.reduce((sum, f) => (isUploadOutstanding(f.status) ? sum + f.size : sum), 0),
    [filesApi.files],
  );
  const signedIn = state.auth.configured && state.auth.state === "signedIn";
  const bytesStored = state.status?.bytesStored ?? null;
  const usedBytes = bytesStored == null ? null : bytesStored + inFlightBytes;
  // Is the vault total merely *late*, or genuinely unavailable? A null `bytesStored` alone can't say, and
  // the answer differs entirely for the user: one is a wait, the other is a fact. Two ways it's a wait:
  //   1. the socket hasn't connected yet (getStatus can't land until it does), and
  //   2. it HAS connected, but the daemon's snapshot still says `signedIn: false` — i.e. we read it before
  //      `authenticate` established the session, so its nulls describe a daemon that didn't know us yet.
  // (2) is the common one and used to persist for minutes; the controller now re-reads on the daemon's
  // session-established push, so this covers the seconds in between rather than a stuck state. Guarded on
  // the app's own sign-in so a genuinely signed-out install shows an absence, not a spinner that never ends.
  const storageFigurePending =
    bytesStored == null && signedIn && (state.connection !== "connected" || state.status?.signedIn !== true);
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
  // Is there anything to sell this account? ONE rule, used by both upgrade doors (the sidebar button and
  // the account popover's item) — they were two expressions of it, which disagreed in the seconds before
  // entitlement lands: `!active` alone is true for a subscriber whose status hasn't arrived yet, so the
  // popover briefly offered "Upgrade" to someone who already pays. Waiting for `known` fails CLOSED, which
  // is the right way round for an upsell: showing it late is nothing, showing it wrongly is a bad moment.
  const canUpgrade = signedIn && state.entitlement.known && !subscribed;
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
    void fn().catch((e: unknown) => toast.error(e instanceof Error ? e.message : String(e)));
  };

  // Excludes are daemon-backed now (the SSOT): list comes from the store, add/remove issue commands and
  // the `excludesChanged` refetch reconciles. No local state to drift.
  const settings: SettingsApi = {
    excludes: state.excludes,
    addExclude: (pattern) => exec(() => api.request("addExclude", { pattern })),
    removeExclude: (pattern) => exec(() => api.request("removeExclude", { pattern })),
  };

  // Counts REQUESTS, not files — the badge must agree with the rows the page shows, and a folder ask is
  // one row there ("Photos"), not 300. Same fold the page itself uses.
  const activeDownloads = useMemo(
    () => groupDownloads(state.restores).filter((g) => isActiveRestore(g.state)).length,
    [state.restores],
  );
  const notRunning = NOT_RUNNING[state.connection];

  const NAV: NavItem[] = [
    { id: "files", label: "My Files", icon: "folder" },
    // Above Settings, and carrying the in-flight count: the badge belongs on the page that can explain it.
    { id: "downloads", label: "Downloads", icon: "download", badge: activeDownloads },
    { id: "settings", label: "Settings", icon: "settings" },
  ];

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
      {/* The one place in the app that asks for money without being asked first. It's here rather than in
          the nav rail because it isn't a destination, and it's a real button because Ben's point stands:
          a free account had no way to buy more room short of hunting through Settings. Free accounts only,
          and it disappears the moment there's a subscription — there's nothing to sell to someone who
          already bought, and a permanent upsell in the chrome would be the opposite of what this app is. */}
      {canUpgrade && (
        <Button
          variant="primary"
          size="sm"
          icon="rocket_launch"
          full
          className="cs-upgrade"
          onClick={() => setPaywallReason("upgrade")}
        >
          Upgrade
        </Button>
      )}
      {notRunning && (
        <div className="cs-status">
          <span className={`cs-dot cs-dot--${state.connection}`} />
          {notRunning}
        </div>
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

  // The daemon's live error channel. It's STATE, not a stream — no id, no timestamp — so the effect keys
  // on the message and the toast layer collapses repeats. Command rejections take their own route
  // (`exec` above, which has the rejection in hand); this is for faults nobody asked for.
  const lastError = state.lastError;
  const lastErrorCode = state.lastErrorCode;
  useEffect(() => {
    if (!lastError) return;
    // A denied Photos grant can't be re-prompted for by the daemon, so the toast carries the only way out.
    toast.error(
      lastError,
      lastErrorCode === "photosAccessDenied"
        ? { label: "Open Photos settings", onClick: () => void api.openPhotosSettings() }
        : undefined,
    );
  }, [lastError, lastErrorCode, api, toast]);

  // Every finished transfer says so, wherever the user happens to be. This is the completion the whole
  // request flow promises ("we'll let you know when it's ready") and the app had no way to make good on:
  // a transfer that landed while you were looking at Settings announced itself nowhere.
  useEffect(
    () =>
      api.onEvent((name, data) => {
        // Through `eventAction` rather than reading `data` off the generic pair: the generic doesn't narrow
        // on a `name` check, and that helper is where this layer's one correlated-pair cast already lives.
        const e = eventAction(name, data);
        if (e.type !== "event" || e.name !== "restoreCompleted") return;
        const out = e.data.out;
        toast.success(`${out.split("/").at(-1)} is saved on your Mac.`, {
          label: "Show in Finder",
          onClick: () => void api.revealInFinder(out),
        });
      }),
    [api, toast],
  );

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
        onCancelSignIn={() => {}}
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
          onCancelSignIn={() => void api.cancelSignIn()}
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
              usagePending={storageFigurePending}
              quotaBytes={state.entitlement.quotaBytes}
              onOpenSettings={() => {
                setSettingsTab("account");
                setRoute("settings");
              }}
              canUpgrade={canUpgrade}
              onUpgrade={() => setPaywallReason("upgrade")}
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
          requestFileIds={requestFileIds}
          onRequestOpened={() => setRequestFileIds(null)}
          onShowDownloads={() => setRoute("downloads")}
        />
      )}
      {route === "downloads" && (
        <DownloadsView
          api={api}
          exec={exec}
          restores={state.restores}
          restoreProgress={state.restoreProgress}
          staleAfter={staleAfter}
          onRequestAgain={(fileIds) => {
            setRequestFileIds(fileIds);
            setRoute("files");
          }}
        />
      )}
      {route === "settings" && (
        <SettingsView
          api={api}
          exec={exec}
          sources={state.status?.sources ?? []}
          running={state.run?.active ?? false}
          settings={settings}
          bytesStored={bytesStored}
          bytesStoredPending={storageFigurePending}
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
    </div>
  );
};
