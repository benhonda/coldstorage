/**
 * Settings — the rules behind My Files (the *stuff* lives there; the *rules* live here). Watched folders
 * (auto-sync, demoted from the old home hero), what not to back up, and storage/cost. Fully daemon-backed
 * now: sources (each with a destination mount + per-folder pause/resume), catch-up, excludes ({@link
 * SettingsApi}), and the storage-cost estimate (the
 * daemon's pricing rate card).
 */
import { useState } from "react";
import type { AuthStatus, Pricing, Source } from "../../../shared/ipc.ts";
import type { ViewProps } from "./types.ts";
import type { ArchivedFile } from "./files/model.ts";
import { baseName, formatBytes } from "./files/model.ts";
import { formatUsd, monthlyStorageUsd } from "./files/pricing.ts";
import { AddWatchedFolderModal } from "./files/AddWatchedFolderModal.tsx";
import { ContextMenu, type MenuEntry } from "./files/ContextMenu.tsx";
import { Badge, Button, Card, Chip, EmptyState, Field, Icon, IconButton, KeyValueRow, Modal } from "../ui/primitives.tsx";
import { Page } from "../ui/layout.tsx";

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
  pricing,
  vaultBytes,
  files,
  virtualFolders,
  auth,
}: ViewProps & {
  /** Sign-in status (Phase 5). The account card renders only for a configured (multi-user) install —
   * dogfood mode has no account to show. */
  auth: AuthStatus;
  sources: Source[];
  /** A scan is in flight — the LIVE run state (`state.run.active`), folded from runStarted/runFinished.
   * NOT `status.running`, which only updates on a getStatus poll and so never flips during a quick run. */
  running: boolean;
  settings: SettingsApi;
  pricing: Pricing;
  vaultBytes: number;
  files: ArchivedFile[];
  virtualFolders: string[];
}): React.JSX.Element => {
  const [adding, setAdding] = useState(false);
  const [pattern, setPattern] = useState("");
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuEntry[] } | null>(null);
  const [removing, setRemoving] = useState<Source | null>(null);

  /** Shorten a macOS home path for display: /Users/ben/Downloads/x → ~/Downloads/x (full path on hover). */
  const tildify = (p: string): string => p.replace(/^\/Users\/[^/]+\//, "~/");
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

  return (
    <Page title="Settings">
      <Card title="Watched folders" action={watchActions}>
        {sources.length > 0 ? (
          <>
            <p className="cs-help" style={{ marginBottom: "var(--space-4)" }}>
              Folders coldstorage keeps current as they change. Their files show in My Files with an auto
              marker. Done-once folders don't need watching — just drop them into My Files.
            </p>
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

      <Card title="Don't back up">
        <p className="cs-help" style={{ marginBottom: "var(--space-4)" }}>
          coldstorage skips these everywhere — caches and junk you never mean to keep.
        </p>
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

      <Card title="Storage">
        <KeyValueRow label="In deep storage" value={formatBytes(vaultBytes)} accent />
        <KeyValueRow label="Roughly" value={`${formatUsd(monthlyStorageUsd(pricing, vaultBytes))}/month (estimate)`} />
        <KeyValueRow label="Encryption" value="on this Mac, before upload" icon="lock" />
        <p className="cs-help" style={{ marginTop: "var(--space-3)" }}>{pricing.note}</p>
      </Card>

      {auth.configured && (
        <Card
          title="Account"
          action={
            <Button size="sm" icon="logout" onClick={() => exec(() => api.signOut())}>
              Sign out
            </Button>
          }
        >
          <KeyValueRow label="Signed in as" value={auth.email ?? "—"} />
        </Card>
      )}
    </Page>
  );
};
