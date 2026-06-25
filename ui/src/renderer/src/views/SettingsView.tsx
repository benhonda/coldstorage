/**
 * Settings — the rules behind My Files (the *stuff* lives there; the *rules* live here). Watched folders
 * (auto-sync, demoted from the old home hero), what not to back up, and storage/cost. Fully daemon-backed
 * now: sources, pause/resume/catch-up, excludes ({@link SettingsApi}), and the storage-cost estimate (the
 * daemon's pricing rate card).
 */
import { useState } from "react";
import type { Pricing, Source, Status } from "../../../shared/ipc.ts";
import type { ViewProps } from "./types.ts";
import { formatBytes } from "./files/model.ts";
import { formatUsd, monthlyStorageUsd } from "./files/pricing.ts";
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
}: ViewProps & {
  sources: Source[];
  status: Status | null;
  settings: SettingsApi;
  pricing: Pricing;
  vaultBytes: number;
}): React.JSX.Element => {
  const [path, setPath] = useState("");
  const [pattern, setPattern] = useState("");
  const running = status?.running ?? false;
  const paused = status?.paused ?? false;

  const addFolder = (): void => {
    const trimmed = path.trim();
    if (!trimmed) return;
    // SEAM: native folder picker (dialog.showOpenDialog in main) is a polish follow-up; typed for now.
    exec(() => api.request("addSource", { path: trimmed }));
    setPath("");
  };

  const addPattern = (): void => {
    settings.addExclude(pattern);
    setPattern("");
  };

  const watchActions = (
    <div className="cs-cluster">
      <Button
        icon="sync"
        disabled={running || sources.length === 0}
        onClick={() => exec(() => api.request("triggerNow"))}
      >
        {running ? "Catching up…" : "Catch up now"}
      </Button>
      {paused ? (
        <Button icon="play_arrow" onClick={() => exec(() => api.request("resume"))}>
          Resume
        </Button>
      ) : (
        <Button icon="pause" onClick={() => exec(() => api.request("pause"))}>
          Pause
        </Button>
      )}
    </div>
  );

  return (
    <Page title="Settings" subtitle="The rules behind your files.">
      <Card title="Watched folders" action={watchActions}>
        <p className="cs-help" style={{ marginBottom: "var(--space-4)" }}>
          Folders coldstorage keeps current as they change. Their files show in My Files with an auto
          marker. Done-once folders don't need watching — just drop them into My Files.
        </p>
        {sources.length > 0 ? (
          <div>
            {sources.map((s) => (
              <div className="cs-row" key={s.id}>
                <Icon name="folder" size={22} />
                <div className="cs-row-main">
                  <div className="cs-row-title">{s.path ?? s.id}</div>
                  <div className="cs-row-sub">
                    {s.kind} · {s.id}
                  </div>
                </div>
                <IconButton
                  icon="close"
                  label={`Stop watching ${s.path ?? s.id}`}
                  onClick={() => exec(() => api.request("removeSource", { id: s.id }))}
                />
              </div>
            ))}
          </div>
        ) : (
          <EmptyState icon="create_new_folder" title="No watched folders. Add one to keep it backed up automatically." />
        )}
        <div className="cs-stack" style={{ marginTop: "var(--space-4)" }}>
          <Field
            label="Folder path"
            placeholder="/Users/you/Pictures"
            value={path}
            mono
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addFolder()}
          />
          <Button variant="primary" icon="add" disabled={!path.trim()} onClick={addFolder}>
            Add folder
          </Button>
        </div>
      </Card>

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
