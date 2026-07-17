/**
 * Settings — ONE door, two subpages ({@link Tabs}): **General** (how this Mac backs up — watched
 * folders, exclude patterns, the encryption fact) and **Account** (who's signed in and what they pay
 * for — profile, plan + quota, subscription, billing). The split is the ownership line — *"would this
 * setting follow me to a second Mac?"* — so every future setting has an unambiguous home
 * (notification prefs → General; recovery code / devices → a Security tab the day that content
 * exists). Destructive/rare billing actions fold behind a disclosure, last. Dogfood mode
 * (unconfigured) has no account: no tab strip, General's content IS the page, and the storage figure
 * stays here (Storage card) because there's no Account subpage to carry it. Fully daemon-backed:
 * sources (each with a destination mount + per-folder pause/resume), catch-up, and excludes
 * ({@link SettingsApi}).
 *
 * The quota row ("In deep storage — X of Y") lives on Account › Plan & billing, beside its remedy
 * (Change plan); the sidebar chip's meter is the ambient copy. It used to sit here as a Storage card
 * beside a "Roughly ~$X/month (estimate)" line, removed 2026-07-13: that was OUR AWS cost, not the
 * customer's price — a dogfood-era number that quietly turned customer-facing, the same drift that
 * made the restore dialog understate its charge by ~40× (root `RETRIEVAL.md`). If a cost figure ever
 * returns, it must be the one we actually bill.
 */
import { useState } from "react";
import type { AccountStatus, AuthStatus, EntitlementStatus, Source, SubscriptionInfo } from "../../../shared/ipc.ts";
import { ChangePlanModal } from "./ChangePlanModal.tsx";
import type { ViewProps } from "./types.ts";
import type { ArchivedFile } from "./files/model.ts";
import { baseName, formatBytes } from "./files/model.ts";
import { AddWatchedFolderModal } from "./files/AddWatchedFolderModal.tsx";
import { ContextMenu, type MenuEntry } from "./files/ContextMenu.tsx";
import { Badge, Button, Card, Chip, EmptyState, Field, Icon, IconButton, KeyValueRow, Modal, Tabs } from "../ui/primitives.tsx";
import { Page } from "../ui/layout.tsx";

/** The Settings subpages. `general` = this-Mac behavior; `account` = identity/plan (configured installs only). */
export type SettingsTab = "general" | "account";

const TABS = [
  { id: "general", label: "General" },
  { id: "account", label: "Account" },
] as const satisfies readonly { id: SettingsTab; label: string }[];

/** A watched folder's at-a-glance state. The daemon only exposes a GLOBAL `running` flag (no per-source
 * progress), so a catch-up shows every un-paused folder as syncing — accurate, since a run scans them all.
 * `paused` means the user stopped watching it (the folder + its uploaded files stay; it's just not synced). */
type FolderState = "paused" | "syncing" | "current";
const folderBadge: Record<FolderState, { tone: "warning" | "accent" | "success"; icon: string; label: string }> = {
  paused: { tone: "warning", icon: "visibility_off", label: "Not watching" },
  syncing: { tone: "accent", icon: "sync", label: "Syncing…" },
  current: { tone: "success", icon: "cloud_done", label: "Up to date" },
};

/** The "Don't back up" surface — daemon-backed exclude patterns. The daemon is the SSOT (it seeds the
 * defaults + applies the patterns at scan time); the renderer just lists them and issues add/remove. */
export interface SettingsApi {
  excludes: string[];
  addExclude: (pattern: string) => void;
  removeExclude: (pattern: string) => void;
}

export const SettingsView = ({
  api,
  exec,
  sources,
  running,
  settings,
  bytesStored,
  files,
  virtualFolders,
  auth,
  account,
  entitlement,
  onSubscribe,
  subscription,
  onSubscriptionChanged,
  tab,
  onTabChange,
}: ViewProps & {
  /** Sign-in status (Phase 5). The Account subpage exists only for a configured (multi-user) install —
   * dogfood mode has no account, so no tab strip either. */
  auth: AuthStatus;
  /** Account profile (display name + onboarding facts) — the Name row + its inline edit. */
  account: AccountStatus;
  /** Subscription status (Phase 5c) + a subscribe entry point (non-deposit path to checkout). */
  entitlement: EntitlementStatus;
  onSubscribe: () => void;
  /** The live subscription summary (null = never subscribed) + how to record a plan change. */
  subscription: SubscriptionInfo | null;
  onSubscriptionChanged: (sub: SubscriptionInfo) => void;
  sources: Source[];
  /** A scan is in flight — the LIVE run state (`state.run.active`), folded from runStarted/runFinished.
   * NOT `status.running`, which only updates on a getStatus poll and so never flips during a quick run. */
  running: boolean;
  settings: SettingsApi;
  /** The vault total: a live S3 listing under this user's own prefix — every device, and the figure the
   * plan quota is enforced against. Drives the quota row AND the downgrade warning, so they can never
   * disagree. Null only before the daemon's first listing lands (or signed out). */
  bytesStored: number | null;
  files: ArchivedFile[];
  virtualFolders: string[];
  /** The active subpage — owned by App so the sidebar chip's popover can deep-link to Account.
   * App-owned state also means the last-visited tab survives a trip to My Files and back. */
  tab: SettingsTab;
  onTabChange: (tab: SettingsTab) => void;
}): React.JSX.Element => {
  const [adding, setAdding] = useState(false);
  const [pattern, setPattern] = useState("");
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuEntry[] } | null>(null);
  const [removing, setRemoving] = useState<Source | null>(null);
  const [changingPlan, setChangingPlan] = useState(false);
  // Billing actions folded (destructive last, GitHub/Linear "danger zone" convention): the STATE
  // (Active · renews …) stays visible above; only the rare actions live behind the disclosure.
  const [billingOpen, setBillingOpen] = useState(false);
  // The Name row's inline edit (null = read mode). Also the durable override for a Google user who
  // wants something other than their Google name — our copy is never clobbered by the next sign-in.
  const [editingName, setEditingName] = useState<string | null>(null);
  const [savingName, setSavingName] = useState(false);
  const saveName = (): void => {
    const value = (editingName ?? "").trim();
    if (!value || savingName) return;
    setSavingName(true);
    exec(() =>
      api.setDisplayName(value).finally(() => {
        setSavingName(false);
        setEditingName(null);
      }),
    );
  };

  /** Shorten a macOS home path for display: /Users/ben/Downloads/x → ~/Downloads/x (full path on hover). */
  const tildify = (p: string): string => p.replace(/^\/Users\/[^/]+\//, "~/");
  /** ISO date → "Jan 3, 2027" for the renews/ends lines. */
  const shortDate = (iso: string): string =>
    new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  /** Destination as breadcrumb text: "Backups/Photos" → "My Files / Backups / Photos". */
  const dest = (m: string): string => ["My Files", ...m.split("/").filter(Boolean)].join(" / ");

  const folderState = (s: Source): FolderState => (s.paused ? "paused" : running ? "syncing" : "current");

  // Two distinct ideas, both behind the row's ⋯ (not bare buttons — neither should be a one-misclick):
  //   · Stop/Start watching — a reversible pause. The folder stays in the list and its uploaded files stay
  //     in My Files; it just isn't synced while stopped (the per-source `paused` flag).
  //   · Remove — take the folder off the watch list entirely. Confirmed, since it's the deliberate one
  //     (uploaded files still stay — the confirm says so).
  const openRowMenu = (e: React.MouseEvent, s: Source): void => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          label: s.paused ? "Start watching" : "Stop watching",
          icon: s.paused ? "play_arrow" : "pause",
          onClick: () => exec(() => api.request(s.paused ? "resumeSource" : "pauseSource", { id: s.id })),
        },
        "separator",
        { label: "Remove…", icon: "delete", danger: true, onClick: () => setRemoving(s) },
      ],
    });
  };

  const confirmRemove = (s: Source): void => {
    exec(() => api.request("removeSource", { id: s.id }));
    setRemoving(null);
  };

  const addWatched = (path: string, mountPath: string): void => {
    exec(() => api.request("addSource", { path, mountPath }));
    setAdding(false);
  };

  const addPattern = (): void => {
    settings.addExclude(pattern);
    setPattern("");
  };

  // Header action stays global to *catching up* (scan everything now); pause/resume is per-folder (on
  // each row) — there's no global pause. Compact (sm) so the card header row isn't inflated.
  const watchActions = (
    <div className="cs-cluster">
      <Button
        size="sm"
        icon="sync"
        disabled={running || sources.length === 0}
        onClick={() => exec(() => api.request("triggerNow"))}
      >
        {running ? "Syncing…" : "Sync now"}
      </Button>
    </div>
  );

  const addButton = (
    <Button variant="primary" icon="add" onClick={() => setAdding(true)}>
      Add a watched folder
    </Button>
  );

  const quotaValue =
    bytesStored == null
      ? "—"
      : entitlement.quotaBytes != null
        ? `${formatBytes(bytesStored)} of ${formatBytes(entitlement.quotaBytes)}`
        : formatBytes(bytesStored);

  const hasAccount = auth.configured;
  const active: SettingsTab = hasAccount ? tab : "general";

  const general = (
    <>
      <Card
        title="Watched folders"
        action={watchActions}
        // Only with folders present — the empty state carries its own explanatory copy, so a card
        // description here would say it twice.
        description={
          sources.length > 0
            ? "Folders coldstorage keeps current as they change. Their files show in My Files with an auto marker. Done-once folders don't need watching — just drop them into My Files."
            : undefined
        }
      >
        {sources.length > 0 ? (
          <>
            <div>
              {sources.map((s) => {
                const st = folderState(s);
                const badge = folderBadge[st];
                return (
                  <div
                    className={s.paused ? "cs-row cs-row--paused" : "cs-row"}
                    key={s.id}
                    onContextMenu={(e) => openRowMenu(e, s)}
                  >
                    <span className="cs-watch-folder-icon">
                      <Icon name="folder" size={22} />
                    </span>
                    <div className="cs-row-main">
                      {/* source → destination: the watched folder on the Mac (~-shortened, full path on
                          hover), then where its files land in My Files. */}
                      <div className="cs-watch-src" title={s.path ?? s.id}>{tildify(s.path ?? s.id)}</div>
                      <div className="cs-watch-dest">
                        <Icon name="subdirectory_arrow_right" size={16} />
                        {s.mountPath ? dest(s.mountPath) : "My Files"}
                      </div>
                    </div>
                    {/* Status at a glance — the badge carries the live state (amber Paused on a dimmed row
                        reads loud, so the folder never looks protected when it isn't). */}
                    <Badge tone={badge.tone} icon={badge.icon}>{badge.label}</Badge>
                    <IconButton
                      icon="more_horiz"
                      label={`Actions for ${s.path ?? s.id}`}
                      className="cs-iconbtn--ghost"
                      onClick={(e) => openRowMenu(e, s)}
                    />
                  </div>
                );
              })}
            </div>
            <div style={{ marginTop: "var(--space-4)" }}>{addButton}</div>
          </>
        ) : (
          <EmptyState
            icon="create_new_folder"
            title="No watched folders yet"
            description="Watch a folder and coldstorage uploads its new and changed files on its own — they show up in My Files."
            action={addButton}
          />
        )}
      </Card>

      {/* Always-visible chips, deliberately NOT folded behind a disclosure: in a backup product, what's
          NOT being uploaded is the most dangerous setting in the app — it stays in plain sight. */}
      <Card title="Don't back up" description="coldstorage skips these everywhere — caches and junk you never mean to keep.">
        <div className="cs-chips">
          {settings.excludes.map((p) => (
            <Chip key={p} mono onRemove={() => settings.removeExclude(p)}>
              {p}
            </Chip>
          ))}
        </div>
        <div className="cs-stack" style={{ marginTop: "var(--space-4)" }}>
          <Field
            label="Add a pattern"
            placeholder="*.log"
            value={pattern}
            mono
            onChange={(e) => setPattern(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addPattern()}
          />
          <Button icon="add" disabled={!pattern.trim()} onClick={addPattern}>
            Add pattern
          </Button>
        </div>
      </Card>

      {hasAccount ? (
        // Signed-in installs: the quota row lives on Account › Plan & billing (beside its remedy);
        // only the this-Mac fact remains here.
        <Card title="This Mac">
          <KeyValueRow label="Encryption" value="on this Mac, before upload" icon="lock" />
        </Card>
      ) : (
        // Dogfood mode has no Account subpage to carry the figure, so the original Storage card stands.
        <Card title="Storage">
          {/* ONE number, one meaning: `bytesStored` is a live listing of what's actually in the user's own
              vault, so it counts every device they've deposited from and it's the figure the plan's quota is
              enforced against. Never reintroduce a second, journal-summed total beside it. */}
          <KeyValueRow label="In deep storage" value={quotaValue} accent />
          <KeyValueRow label="Encryption" value="on this Mac, before upload" icon="lock" />
        </Card>
      )}
    </>
  );

  const accountPage = hasAccount && (
    <>
      <Card
        title="Account"
        action={
          <Button size="sm" icon="logout" onClick={() => exec(() => api.signOut())}>
            Sign out
          </Button>
        }
      >
        <KeyValueRow
          label="Name"
          value={
            editingName !== null ? (
              <span className="cs-plan-row">
                <Field
                  label="Name"
                  value={editingName}
                  autoFocus
                  onChange={(e) => setEditingName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && saveName()}
                />
                <Button size="sm" icon="check" onClick={saveName}>
                  {savingName ? "Saving…" : "Save"}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEditingName(null)}>
                  Cancel
                </Button>
              </span>
            ) : (
              <span className="cs-plan-row">
                {account.displayName ?? "—"}
                <Button size="sm" icon="edit" onClick={() => setEditingName(account.displayName ?? "")}>
                  Edit
                </Button>
              </span>
            )
          }
        />
        <KeyValueRow label="Signed in as" value={auth.email ?? "—"} />
      </Card>

      <Card title="Plan & billing">
        {subscription && (
          <KeyValueRow
            label="Plan"
            value={
              <span className="cs-plan-row">
                {subscription.plan ? (
                  <Badge tone="accent">
                    {subscription.plan.size} · {subscription.plan.years} yr{subscription.plan.years > 1 ? "s" : ""}
                  </Badge>
                ) : (
                  // A price that predates the current plan lineup (e.g. sold before a catalog
                  // reshape) — still fully changeable; the picker just starts from the default.
                  <Badge tone="neutral">Earlier plan</Badge>
                )}
                <Button size="sm" icon="swap_horiz" onClick={() => setChangingPlan(true)}>
                  Change plan
                </Button>
              </span>
            }
          />
        )}
        <KeyValueRow label="In deep storage" value={quotaValue} accent />
        <KeyValueRow
          label="Subscription"
          value={
            subscription?.cancelsAt ? (
              <Badge tone="warning" icon="event">Ends {shortDate(subscription.cancelsAt)}</Badge>
            ) : entitlement.active ? (
              <Badge tone="success" icon="check">
                {subscription?.nextBilledAt ? `Active · renews ${shortDate(subscription.nextBilledAt)}` : "Active"}
              </Badge>
            ) : (
              // No subscription = the free tier, not a dead account. Name the plan they're on before
              // offering the one they aren't; the quota row above already shows it filling up.
              <span className="cs-plan-row">
                <Badge tone="neutral">Free</Badge>
                <Button size="sm" onClick={onSubscribe}>
                  {entitlement.checkingOut ? "Finishing…" : "Upgrade"}
                </Button>
              </span>
            )
          }
        />
        {subscription && (
          <>
            <button
              type="button"
              className={billingOpen ? "cs-disclose cs-disclose--open" : "cs-disclose"}
              aria-expanded={billingOpen}
              onClick={() => setBillingOpen((v) => !v)}
            >
              <Icon name="chevron_right" size={18} />
              Billing
            </button>
            {billingOpen && (
              <div className="cs-plan-row cs-disclose-body">
                <Button size="sm" icon="credit_card" onClick={() => exec(() => api.openManage("payment"))}>
                  Update payment method
                </Button>
                {!subscription.cancelsAt && (
                  <Button size="sm" icon="cancel" onClick={() => exec(() => api.openManage("cancel"))}>
                    Cancel subscription
                  </Button>
                )}
              </div>
            )}
          </>
        )}
      </Card>
    </>
  );

  return (
    <Page title="Settings">
      {hasAccount && <Tabs tabs={TABS} active={active} onChange={onTabChange} label="Settings sections" />}

      {active === "general" ? general : accountPage}

      {adding && (
        <AddWatchedFolderModal
          files={files}
          virtualFolders={virtualFolders}
          chooseFolder={api.chooseFolder}
          onAdd={addWatched}
          onClose={() => setAdding(false)}
        />
      )}

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}

      {removing && (
        <Modal
          title="Remove this watched folder?"
          icon="delete"
          onClose={() => setRemoving(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setRemoving(null)}>
                Keep watching
              </Button>
              <Button variant="danger" icon="delete" onClick={() => confirmRemove(removing)}>
                Remove
              </Button>
            </>
          }
        >
          <p className="cs-quote-lead">
            coldstorage stops watching <strong>{baseName(removing.path ?? removing.id)}</strong> and takes it
            off this list. Files it already uploaded stay in My Files — this doesn&apos;t delete anything
            you&apos;ve backed up.
          </p>
        </Modal>
      )}

      {changingPlan && subscription && (
        <ChangePlanModal
          api={api}
          current={subscription}
          bytesStored={bytesStored}
          onChanged={onSubscriptionChanged}
          onClose={() => setChangingPlan(false)}
        />
      )}
    </Page>
  );
};
