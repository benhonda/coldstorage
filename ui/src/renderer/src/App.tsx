/**
 * Layer-3 shell — the reorganizable-filesystem design. Two surfaces: **My Files** (the drive: browse,
 * deposit, reorganize, request-back) and **Settings** (the rules). The renderer is a pure consumer of
 * `window.coldstore` (commands) + the folded store (event-driven state); no archive logic here.
 *
 * App owns the cross-view state: the file tree ({@link useFiles}, overlaying transfer status from the
 * store's daemon-backed `restores` list) and daemon-backed settings (excludes from the store, mutated via
 * commands). It threads slices to the three views, keeps the shared `exec` command runner (surfaces
 * rejections as a toast), and pins the foot of the sidebar: a quiet status line only when the background
 * uploader isn't running.
 *
 * In-flight downloads and failed uploads both used to live down there, as a count + popover each. They
 * now have their own pages (Download Requests, Uploads) — a count in the sidebar foot with a popover
 * hanging off it had nowhere to send anyone, and it was built from renderer memory, so it lost the user's
 * downloads on sign-out.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Modal, Button } from "./ui/primitives.tsx";
import { Sidebar, type NavItem } from "./ui/layout.tsx";
import { useToast } from "./ui/toast.tsx";
import type { Store } from "./state/store.ts";
import type { Commands } from "../../shared/ipc.ts";
import type { ColdstoreApi, ConnectionState, SubscriptionInfo } from "../../shared/ipc.ts";
import { billingState, subscriptionOf, type Loadable } from "./state/billing.ts";
import { isActiveRestore } from "../../shared/ipc.ts";
import type { Exec } from "./views/types.ts";
import { useAppState } from "./useStore.ts";
import { useResizable } from "./ui/useResizable.ts";
import { baseName, fileFromJournal, isFolderMarker, isUploadOutstanding, parentOf, type ArchivedFile } from "./views/files/model.ts";
import { isOptimisticId, useFiles } from "./views/files/useFiles.ts";
import { UploadsView } from "./views/UploadsView.tsx";
import { buildUploads, type UploadBatch, type WatchedFolder } from "./views/uploads/model.ts";
import { eventAction } from "./state/reducer.ts";
import { bytesAvailable } from "./state/entitlement.ts";
import { formatBytes } from "./views/files/model.ts";
import { MyFilesView, type TreeState } from "./views/MyFilesView.tsx";
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

type Route = "files" | "uploads" | "downloads" | "settings";

const ROUTES: readonly Route[] = ["files", "uploads", "downloads", "settings"];

const isRoute = (id: string): id is Route => (ROUTES as readonly string[]).includes(id);

interface Props {
  api: ColdstoreApi;
  store: Store;
  /** Re-read the tree by hand — the file browser's Retry when a `listFiles` read failed. */
  retryFiles: () => Promise<void>;
  /** Re-read the batch list by hand — the Uploads page's Retry when a `listDeposits` read failed. */
  retryDeposits: () => Promise<void>;
}

export const App = ({ api, store, retryFiles, retryDeposits }: Props): React.JSX.Element => {
  const state = useAppState(store);
  const [route, setRoute] = useState<Route>("files");
  // Settings' active subpage, owned here (not in SettingsView) for two reasons: the sidebar chip's
  // popover deep-links to Settings › Account, and the last-visited tab survives a trip to My Files.
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("general");
  const toast = useToast();
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
  // Is the vault total merely *late*, or genuinely unavailable? A null `bytesStored` means "not arrived
  // yet", and while signed in it is ALWAYS a wait — `getStatus` now answers instantly from the journal and
  // fills `bytesStored` from a BACKGROUND S3 listing (it used to block the whole status call on that
  // listing, which hung the app on a flaky network — 2026-08-25). So a null here after sign-in is the gap
  // between the first getStatus and the background refresh landing, not an absence. Treating it as absent
  // is what made the storage bar VANISH instead of showing a loading state (the same PILLAR5 error, one
  // regression later). Pending whenever we're signed in and don't have the number yet.
  const storageFigurePending = bytesStored == null && signedIn;
  // Is the file tree a fact yet? Same discipline as the storage figure, applied to the thing that matters
  // most: the browser must never paint "your vault is empty — drop something" unless the vault IS empty.
  // Three honest states short of that: the socket isn't connected; it is, but the daemon hasn't opened
  // our session yet (`status.signedIn` false — its reads are empty-but-successful until `authenticate`
  // lands); or the read itself failed. And one cross-check against the daemon's own count: if `getStatus`
  // says the vault holds files and the list came back empty, something is wrong and we say so rather than
  // show a hero over 140k files (2026-08-25).
  const treeState: TreeState = (() => {
    // Not connected to the daemon yet → genuinely still connecting.
    if (state.connection !== "connected") return { state: "connecting" };
    // A FAILED read is checked BEFORE "session not ready" — because when the daemon is wedged, getStatus
    // (which sets `status.signedIn`) times out too, so `signedIn` never flips true and the old order left
    // the user on an eternal "Connecting to your vault…" with no recourse (2026-08-25). A rejected read is
    // the honest signal that something's wrong; surface it with its reason and a Retry.
    if (state.filesLoad.state === "failed") return { state: "failed", reason: state.filesLoad.error };
    // Connected, reads haven't failed, but the daemon hasn't reported our session yet (or the tree is still
    // loading) → a bounded "connecting". The gate escalates this to a Retry on its own after a while, so it
    // can't become the dead end it was.
    if (state.status?.signedIn !== true || state.filesLoad.state === "pending") return { state: "connecting" };
    if (state.files.length === 0 && state.status.filesTotal > 0) {
      return {
        state: "failed",
        reason: `the vault reports ${state.status.filesTotal.toLocaleString()} files but the list came back empty`,
      };
    }
    return { state: "ready" };
  })();
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
  // The blocked deposit's own size — because "you can't upload this" has two different truths behind it,
  // and the old modal only ever told one of them. A vault with 10 GB left refusing a 30 GB folder is NOT
  // "you've used all of your storage"; saying so sends the user hunting for files to delete when the real
  // answer is that this one drop doesn't fit. Null = nothing blocked.
  const [blockedBytes, setBlockedBytes] = useState<number | null>(null);
  // Which of the two truths this block is. A vault with room left that still refused the drop can only mean
  // the drop itself was too big; zero room left means full, full stop.
  const tooBigForRoomLeft = blockedBytes != null && blockedBytes > 0 && roomLeft != null && roomLeft > 0;
  const [changingPlanFromCapacity, setChangingPlanFromCapacity] = useState(false);
  useEffect(() => {
    if (canDeposit) {
      setBlockedBytes(null);
      setChangingPlanFromCapacity(false);
    }
  }, [canDeposit]);

  // The live subscription summary (plan badge + Settings billing panel). Refetched on sign-in and
  // whenever the entitlement flips (a checkout just landed / a cancellation took effect).
  //
  // A LOADABLE, not `SubscriptionInfo | null`. This used to be best-effort — a fetch failure was caught
  // into `null`, which the UI could not tell apart from "never subscribed", so a paying customer whose
  // read failed got a free-tier card: no plan, no price, no way to cancel, under a green Active badge
  // fed by the separate (cached) entitlement flag. Keeping the failure representable is the fix; every
  // consumer goes through `billingState` and renders the `unavailable` branch (PILLAR5).
  const [subscription, setSubscription] = useState<Loadable<SubscriptionInfo | null>>({ status: "loading" });
  // Bumped by the panel's Retry — re-runs the effect below without a page reload.
  const [subscriptionAttempt, setSubscriptionAttempt] = useState(0);

  // Session-local "the wizard's final Continue was clicked" — the fail-open half of onboarding: the
  // server facts are what really end it (onboardingPending), but if the final write failed we still
  // let the user through this session and re-derive next launch. Reset per account.
  const [onboardingDone, setOnboardingDone] = useState(false);
  useEffect(() => setOnboardingDone(false), [state.auth.email]);
  useEffect(() => {
    if (!signedIn) {
      setSubscription({ status: "ready", value: null });
      return;
    }
    let alive = true;
    setSubscription({ status: "loading" });
    api
      .getSubscription()
      .then((value) => alive && setSubscription({ status: "ready", value }))
      .catch((e: unknown) =>
        alive && setSubscription({ status: "error", message: e instanceof Error ? e.message : String(e) }),
      );
    return () => {
      alive = false;
    };
  }, [api, signedIn, state.entitlement.active, subscriptionAttempt]);

  // The one derivation of "what billing state is this account in", shared by the sidebar chip and the
  // Settings panel so the two can never disagree (they used to, each deriving their own).
  const billing = billingState(subscription, state.entitlement);
  /** The subscription behind that state, where there is one — what the change-plan surfaces act on. */
  const currentSubscription = subscriptionOf(billing);
  // Both surfaces record a plan change the same way — straight into the loadable as a fresh answer.
  const recordSubscription = (value: SubscriptionInfo): void => setSubscription({ status: "ready", value });

  const exec: Exec = (fn) => {
    void fn().catch((e: unknown) => toast.error(e instanceof Error ? e.message : String(e)));
  };

  // Excludes are daemon-backed now (the SSOT): list comes from the store, add/remove issue commands and
  // the `excludesChanged` refetch reconciles. No local state to drift.
  const settings: SettingsApi = {
    excludes: state.excludes,
    suggestions: state.excludeSuggestions,
    addExclude: (pattern) => exec(() => api.request("addExclude", { pattern })),
    // Turning a whole pack on. Sequential, not `Promise.all`: each `addExclude` is a write to the same
    // journal table and publishes its own `excludesChanged`, and one rejection has to stop the rest rather
    // than leave the pack half-applied behind an error toast.
    addExcludes: (patterns) =>
      exec(async () => {
        for (const pattern of patterns) await api.request("addExclude", { pattern });
      }),
    removeExclude: (pattern) => exec(() => api.request("removeExclude", { pattern })),
    removeExcludes: (patterns) =>
      exec(async () => {
        for (const pattern of patterns) await api.request("removeExclude", { pattern });
      }),
  };

  // Counts REQUESTS, not files — the badge must agree with the rows the page shows, and a folder ask is
  // one row there ("Photos"), not 300. Same fold the page itself uses.
  const activeDownloads = useMemo(
    () => groupDownloads(state.restores).filter((g) => isActiveRestore(g.state)).length,
    [state.restores],
  );
  const notRunning = NOT_RUNNING[state.connection];

  // ── uploads: ONE truth, folded per batch ──
  // The Uploads page's rows: the daemon's batches (`listDeposits`) with the SAME tree rows the browser
  // draws folded in by `depositId`, so a batch's "3 of 500 couldn't upload" and the tree's three ⚠ rows
  // are one fact. The nav badge is the failed-row count off the same fold. This replaced a sidebar-foot
  // pill + popover that had nowhere to send anyone and no button for the case that mattered most (a drop
  // interrupted by a restart) — the same promotion Downloads got, for the same reason.
  const uploads = useMemo(
    () => buildUploads(state.deposits, filesApi.files, state.status?.sources ?? [], state.run?.active ?? false),
    [state.deposits, filesApi.files, state.status?.sources, state.run?.active],
  );

  const NAV: NavItem[] = [
    { id: "files", label: "My Files", icon: "folder" },
    // Each carries the count that its page explains: uploads that need a hand, downloads in flight.
    { id: "uploads", label: "Uploads", icon: "cloud_upload", badge: uploads.failedTotal, badgeLabel: "couldn't upload" },
    { id: "downloads", label: "Download Requests", icon: "download", badge: activeDownloads, badgeLabel: "in progress" },
    { id: "settings", label: "Settings", icon: "settings" },
  ];

  /** Tell the user what a retry could NOT do. The rows already carry the daemon's verdict (it wrote the
   * kind onto each one — `missingSource`), so this is the headline only. */
  const reportMissing = (missing: number): void => {
    if (missing > 0) toast.error(`${missing.toLocaleString()} ${missing === 1 ? "file" : "files"} couldn’t be found on disk — see the row for what to do.`);
  };

  /** What a retry covers: a handful of rows, one batch, or one watched folder. The last two are resolved
   * by the daemon from the journal — never a 56k-id list from here; the rows are only needed locally to
   * price the retry against the quota and flip them optimistically. */
  type RetryScope = ArchivedFile[] | { depositId: string } | { sourceMount: string };
  const retryTargets = (scope: RetryScope): ArchivedFile[] => {
    if (Array.isArray(scope)) return scope;
    if ("depositId" in scope) return uploads.batches.find((b) => b.id === scope.depositId)?.failures.flatMap((g) => g.files) ?? [];
    return uploads.folders.find((f) => f.source.mountPath === scope.sourceMount)?.failures.flatMap((g) => g.files) ?? [];
  };
  const retryParams = (scope: RetryScope, journal: ArchivedFile[]): Commands["retryFiles"]["params"] =>
    Array.isArray(scope) ? { ids: journal.map((f) => f.id).join("\n") } : scope;

  /** Re-upload failed rows from their recorded sources. A journal row goes through `retryFiles` (the
   * daemon requeues it and reopens its batch); an optimistic row the daemon never saw re-issues its
   * original `deposit`. */
  const retryUploads = (scope: RetryScope): void => {
    const targets = retryTargets(scope);
    const withSource = targets.filter((f) => f.status === "failed" && f.sourcePath !== null);
    if (withSource.length === 0) return;
    // Bytes that never landed are incoming again — gate them like any deposit.
    const incoming = withSource.reduce((sum, f) => sum + f.size, 0);
    if (!hasRoomFor(incoming)) {
      if (subscribed) setBlockedBytes(incoming);
      else setPaywallReason("quotaReached");
      return;
    }
    const optimistic = withSource.filter((f) => isOptimisticId(f.id));
    const journal = withSource.filter((f) => !isOptimisticId(f.id));
    // Flip optimistically; if the command itself is refused, put the rows back AS THEY WERE (their real
    // failure kind included) — the retry didn't happen, which is not the same as a fresh failure.
    filesApi.setDepositStatus(withSource.map((f) => f.id), "uploading");
    for (const f of optimistic) {
      const src = f.sourcePath;
      if (src === null) continue; // filtered above; narrows the type without a cast
      exec(() =>
        api.request("deposit", { src, dest: parentOf(f.relativePath) }).catch((e: unknown) => {
          filesApi.restoreRows([f]);
          throw e;
        }),
      );
    }
    if (journal.length > 0) {
      exec(async () => {
        const r = await api
          .request("retryFiles", retryParams(scope, journal))
          .catch((e: unknown) => {
            filesApi.restoreRows(journal);
            throw e;
          });
        reportMissing(r.missing); // the rows themselves re-read with the daemon's verdict (`filesChanged`)
      });
    }
  };

  /** "Locate…": the user points at where the file is, and it retries from there — recorded on the row, so
   * a later retry needs no asking. An optimistic row (no journal row yet) just deposits the picked path. */
  const locateUpload = (file: ArchivedFile): void => {
    exec(async () => {
      const picked = await api.chooseFile(baseName(file.relativePath));
      if (!picked) return;
      filesApi.setDepositStatus([file.id], "uploading");
      if (isOptimisticId(file.id)) {
        await api.request("deposit", { src: picked, dest: parentOf(file.relativePath) }).catch((e: unknown) => {
          filesApi.restoreRows([file]);
          throw e;
        });
        return;
      }
      const r = await api.request("retryFiles", { ids: file.id, sourcePath: picked }).catch((e: unknown) => {
        filesApi.restoreRows([file]);
        throw e;
      });
      reportMissing(r.missing); // only a folder pick or a race with the disk can land here
    });
  };

  /** "Remove these" on a batch that didn't finish: take its failed files out of the backup, tree first
   * (instant), then the journal (one command — never a per-file loop over 56k rows). */
  const removeFailedBatch = (b: UploadBatch): void => {
    const failed = b.failures.flatMap((g) => g.files);
    filesApi.remove(failed.map((f) => ({ kind: "file", id: f.id, path: f.relativePath })));
    exec(() => api.request("removeFailedFiles", { depositId: b.id }));
  };

  /** "Remove" on one failed row: take the file out of the backup. No bytes are at stake (nothing landed),
   * so no confirm — but a file inside a watched folder WILL be found again by the next scan, and the
   * daemon tells us so; we pass that on rather than let it silently reappear. */
  const removeUpload = (file: ArchivedFile): void => {
    filesApi.remove([{ kind: "file", id: file.id, path: file.relativePath }]);
    if (isOptimisticId(file.id)) return; // never reached the daemon — nothing to delete there
    exec(async () => {
      const r = await api.request("deletePath", { path: file.relativePath });
      if (r.isWatched) {
        // An error toast, deliberately: it waits to be read, and "this will come back" is something the
        // user has to act on.
        toast.error(`Removed — but “${baseName(file.relativePath)}” is inside a watched folder, so the next scan will find it again. To keep it out, delete it in My Files and choose “Don’t back up”.`);
      }
    });
  };

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
    // A background run hit the quota — no single deposit to blame and no size to quote, so this is the
    // plain "full" case (0 ⇒ the vault is full, not "this one is too big").
    if (subscribed) setBlockedBytes(0);
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
    // A one-time code outside the wizard: either a Settings › Account reissue (the account already
    // confirmed a code — this replaces it), or the fallback for account facts unknown (the account
    // server was unreachable while a fresh mint still produced a code), so it's never lost unseen.
    if (v.recoveryCode) {
      return (
        <RecoveryCodeShow
          code={v.recoveryCode}
          email={email}
          {...(state.account.recoveryCodeConfirmed
            ? {
                intro:
                  "Here's your new recovery code. Your old one no longer works. This is how you get back into your files on another computer — keep it somewhere you won't lose it.",
              }
            : {})}
          onAcknowledge={() => {
            void api.acknowledgeRecoveryCode();
            void api.confirmRecoveryCode().catch(() => undefined);
          }}
          onSignOut={signOut}
        />
      );
    }
    if (v.state !== "unlocked") {
      return (
        <VaultGate
          state={v.state}
          error={v.error}
          email={email}
          connection={state.connection}
          step={v.step}
          stepSince={v.stepSince}
          onSignOut={signOut}
        />
      );
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
              billing={billing}
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

      {route === "files" && (
        <MyFilesView
          api={api}
          exec={exec}
          files={filesApi.files}
          virtualFolders={filesApi.virtualFolders}
          filesApi={filesApi}
          suggestions={state.excludeSuggestions}
          run={state.run}
          tree={treeState}
          onRetryTree={() => exec(retryFiles)}
          hasRoomFor={hasRoomFor}
          onDepositBlocked={(incomingBytes) =>
            subscribed ? setBlockedBytes(incomingBytes) : setPaywallReason("quotaReached")
          }
          onRetryUploads={retryUploads}
          onLocateUpload={locateUpload}
          requestFileIds={requestFileIds}
          onRequestOpened={() => setRequestFileIds(null)}
          onShowDownloads={() => setRoute("downloads")}
        />
      )}
      {route === "uploads" && (
        <UploadsView
          api={api}
          exec={exec}
          model={uploads}
          load={state.depositsLoad}
          onRetryLoad={() => exec(retryDeposits)}
          onRetryBatch={(b: UploadBatch) => retryUploads({ depositId: b.id })}
          onRetryFolder={(f: WatchedFolder) => retryUploads({ sourceMount: f.source.mountPath })}
          onRetryFiles={retryUploads}
          onLocate={locateUpload}
          onRemoveFile={removeUpload}
          onRemoveFailed={removeFailedBatch}
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
          billing={billing}
          onSubscriptionChanged={recordSubscription}
          // Retry BOTH reads: the subscription (this component's) and the entitlement (main's) — the
          // panel's "unavailable" can come from either, and a Retry that only refetched one left the
          // other's failure standing.
          onRetryBilling={() => {
            void api.refreshEntitlement();
            setSubscriptionAttempt((n) => n + 1);
          }}
          tab={settingsTab}
          onTabChange={setSettingsTab}
          appInfo={state.appInfo}
          update={state.update}
          onCheckForUpdate={() => void api.checkForUpdate()}
          onRestartToUpdate={() => void api.restartToUpdate()}
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
      {blockedBytes != null && !changingPlanFromCapacity && (
        <Modal
          title={tooBigForRoomLeft ? "That's more than you have room for" : "Storage full"}
          icon="database"
          onClose={() => setBlockedBytes(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setBlockedBytes(null)}>
                Not now
              </Button>
              {currentSubscription && (
                <Button variant="primary" onClick={() => setChangingPlanFromCapacity(true)}>
                  Change plan
                </Button>
              )}
            </>
          }
        >
          <p>
            {tooBigForRoomLeft
              ? `This upload is ${formatBytes(blockedBytes)}, and you have ${formatBytes(roomLeft ?? 0)} left on your plan. Upload less of it, free up space, or upgrade your plan.`
              : "You've used all of your plan's storage. Free up space, or upgrade your plan to keep backing up."}
          </p>
        </Modal>
      )}
      {changingPlanFromCapacity && currentSubscription && (
        <ChangePlanModal
          api={api}
          current={currentSubscription}
          bytesStored={state.status?.bytesStored ?? null}
          onChanged={(sub) => {
            recordSubscription(sub);
            setChangingPlanFromCapacity(false);
            setBlockedBytes(null);
          }}
          onClose={() => setChangingPlanFromCapacity(false)}
        />
      )}

      <UpdateBanner update={state.update} onRestart={() => void api.restartToUpdate()} />
    </div>
  );
};
