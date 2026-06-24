/**
 * Settings — the rules behind My Files (the *stuff* lives there; the *rules* live here). Watched folders
 * (auto-sync, demoted from the old home hero), what not to back up, storage/cost, and where restores
 * land. All daemon-backed where the command exists (sources, pause/resume, catch-up); the rest binds to
 * {@link useSettings} until the daemon grows the matching commands.
 */
import { useState } from "react";
import type { Source, Status } from "../../../shared/ipc.ts";
import type { ViewProps } from "./types.ts";
import type { SettingsApi } from "./files/useSettings.ts";
import { formatBytes } from "./files/model.ts";
import { Button, Card, Chip, EmptyState, Field, Icon, IconButton, KeyValueRow } from "../ui/primitives.tsx";
import { Page } from "../ui/layout.tsx";

/** Rough Glacier Deep Archive storage rate (USD/GB/month). NOT authoritative — a calm ballpark until
 * the daemon reports real cost. Shown as "~$X/month (estimate)". */
const STORAGE_USD_PER_GB_MONTH = 0.001;

const monthlyEstimate = (bytes: number): string => {
  const usd = (bytes / 1_000_000_000) * STORAGE_USD_PER_GB_MONTH;
  return usd < 0.01 ? "~$0.01/month" : `~$${usd.toFixed(2)}/month`;
};

export const SettingsView = ({
  api,
  exec,
  sources,
  status,
  settings,
  vaultBytes,
}: ViewProps & {
  sources: Source[];
  status: Status | null;
  settings: SettingsApi;
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
        <KeyValueRow label="Roughly" value={`${monthlyEstimate(vaultBytes)} (estimate)`} />
        <KeyValueRow label="Encryption" value="on this Mac, before upload" icon="lock" />
      </Card>
    </Page>
  );
};
