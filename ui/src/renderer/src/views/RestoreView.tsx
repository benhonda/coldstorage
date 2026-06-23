/**
 * Restore — a recovery event (a guided thaw). Deep Archive retrieval can take hours, so the step is
 * idempotent: issue it, and re-issue until the file lands. The activity list reflects the restore*
 * events the daemon pushes; the UI never blocks waiting on a thaw.
 */
import { useState } from "react";
import type { RestoreActivity } from "../state/reducer.ts";
import { Badge, Button, Card, EmptyState, Field } from "../ui/primitives.tsx";
import { Page } from "../ui/layout.tsx";
import type { ViewProps } from "./types.ts";

const STATE_BADGE: Record<RestoreActivity["state"], { tone: "warning" | "accent" | "success"; label: string }> =
  {
    requested: { tone: "warning", label: "thawing" },
    inProgress: { tone: "accent", label: "downloading" },
    completed: { tone: "success", label: "restored" },
  };

export const RestoreView = ({
  api,
  exec,
  activities,
}: ViewProps & { activities: RestoreActivity[] }): React.JSX.Element => {
  const [file, setFile] = useState("");
  const [out, setOut] = useState("");

  const ready = Boolean(file.trim() && out.trim());
  const start = (): void => {
    if (!ready) return;
    exec(() => api.request("restore", { file: file.trim(), out: out.trim() }));
  };

  return (
    <Page title="Restore" subtitle="Recover a file from your vault.">
      <Card title="Recover a file">
        <p className="cs-help">
          Deep Archive retrieval is a guided thaw — it can take hours. Start it, then re-issue the step
          until the file lands; the daemon quotes the wait while it thaws.
        </p>
        <div className="cs-stack" style={{ marginTop: "var(--space-4)" }}>
          <Field label="File id" value={file} mono onChange={(e) => setFile(e.target.value)} />
          <Field
            label="Restore to"
            placeholder="/absolute/out/path"
            value={out}
            mono
            onChange={(e) => setOut(e.target.value)}
          />
          <Button variant="primary" icon="cloud_download" disabled={!ready} onClick={start}>
            Start recovery
          </Button>
        </div>
      </Card>

      <Card title="Recovery activity">
        {activities.length > 0 ? (
          <div>
            {activities.map((a) => {
              const b = STATE_BADGE[a.state];
              return (
                <div className="cs-row" key={a.file}>
                  <Badge tone={b.tone}>{b.label}</Badge>
                  <div className="cs-row-main">
                    <div className="cs-row-title">{a.file}</div>
                    <div className="cs-row-sub">{a.out ?? a.tier ?? ""}</div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <EmptyState icon="cloud_download" title="Restored files will appear here." />
        )}
      </Card>
    </Page>
  );
};
