/**
 * Settings — the rules behind My Files (the *stuff* lives there; the *rules* live here). Watched folders
 * (auto-sync, demoted from the old home hero), what not to back up, and storage/cost. Fully daemon-backed
 * now: sources (each with a destination mount + per-folder pause/resume), catch-up, excludes ({@link
 * SettingsApi}), and the storage-cost estimate (the
 * daemon's pricing rate card).
 */
import { useState } from "react";
import type { Pricing, Source, Status } from "../../../shared/ipc.ts";
import type { ViewProps } from "./types.ts";
import type { ArchivedFile } from "./files/model.ts";
import { formatBytes } from "./files/model.ts";
import { formatUsd, monthlyStorageUsd } from "./files/pricing.ts";
import { AddWatchedFolderModal } from "./files/AddWatchedFolderModal.tsx";
import { Button, Card, Chip, EmptyState, Field, Icon, IconButton, KeyValueRow } from "../ui/primitives.tsx";
import { Page } from "../ui/layout.tsx";

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
  status,
  settings,
  pricing,
  vaultBytes,
  files,
  virtualFolders,
}: ViewProps & {
  sources: Source[];
  status: Status | null;
  settings: SettingsApi;
  pricing: Pricing;
  vaultBytes: number;
  files: ArchivedFile[];
  virtualFolders: string[];
}): React.JSX.Element => {
  const [adding, setAdding] = useState(false);
  const [pattern, setPattern] = useState("");
  const running = status?.running ?? false;

  /** A vault-relative path as breadcrumb-style text: "Backups/Photos" → "Backups / Photos". */
  const asCrumbs = (m: string): string => m.split("/").filter(Boolean).join(" / ");

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
        {running ? "Catching up…" : "Catch up now"}
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
              {sources.map((s) => (
              <div className={s.paused ? "cs-row cs-row--paused" : "cs-row"} key={s.id}>
                <Icon name={s.paused ? "pause_circle" : "folder"} size={22} />
                <div className="cs-row-main">
                  <div className="cs-row-title">{s.path ?? s.id}</div>
                  {/* Paused folders say so loudly (amber) — a backup tool must never look like it's
                      protecting a folder it has quietly stopped syncing. */}
                  <div className="cs-row-sub" style={s.paused ? { color: "var(--amber-500)" } : undefined}>
                    {s.paused
                      ? "Paused — not backing up"
                      : s.mountPath
                        ? `My Files / ${asCrumbs(s.mountPath)}`
                        : s.kind}
                  </div>
                </div>
                <IconButton
                  icon={s.paused ? "play_arrow" : "pause"}
                  label={`${s.paused ? "Resume" : "Pause"} backing up ${s.path ?? s.id}`}
                  onClick={() =>
                    exec(() => api.request(s.paused ? "resumeSource" : "pauseSource", { id: s.id }))
                  }
                />
                <IconButton
                  icon="close"
                  label={`Stop watching ${s.path ?? s.id}`}
                  onClick={() => exec(() => api.request("removeSource", { id: s.id }))}
                />
              </div>
              ))}
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
    </Page>
  );
};
