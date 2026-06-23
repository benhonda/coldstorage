/**
 * Vault — the home / proof-of-safety wall. Leads with the reassuring counts, then surfaces the live
 * run and any failures honestly (named, never hidden — the brand's core promise). All actions go
 * through the daemon over `exec`; this view holds no archive logic.
 */
import type { Status } from "../../../shared/ipc.ts";
import type { BlobFailure, RunProgress } from "../state/reducer.ts";
import { Alert, Badge, Button, Card, EmptyState, Icon, Stat } from "../ui/primitives.tsx";
import { Page } from "../ui/layout.tsx";
import type { ViewProps } from "./types.ts";

const fmt = (n: number): string => n.toLocaleString("en-US");

/** One calm, honest line describing where the vault stands right now. */
const subtitle = (status: Status | null): string => {
  if (!status) return "Connecting to the daemon…";
  if (status.running) return "Backing up now.";
  if (status.paused) return "Backups are paused.";
  if (status.sources.length === 0) return "Add a folder to start your first backup.";
  const waiting = Math.max(0, status.filesTotal - status.filesArchived);
  if (waiting === 0) return "Everything is backed up.";
  return `${fmt(waiting)} ${waiting === 1 ? "file is" : "files are"} waiting to back up.`;
};

export const VaultView = ({
  api,
  exec,
  status,
  run,
  failures,
}: ViewProps & {
  status: Status | null;
  run: RunProgress | null;
  failures: BlobFailure[];
}): React.JSX.Element => {
  const running = status?.running ?? false;
  const paused = status?.paused ?? false;
  const permFailed = status?.permanentlyFailedBlobs ?? 0;

  const actions = (
    <>
      <Button
        variant="primary"
        icon="cloud_upload"
        disabled={running}
        onClick={() => exec(() => api.request("triggerNow"))}
      >
        {running ? "Backing up…" : "Catch up now"}
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
    </>
  );

  return (
    <Page title="Your vault" subtitle={subtitle(status)} actions={actions}>
      {paused && (
        <Alert icon="pause_circle">Backups are paused. Resume to keep your vault current.</Alert>
      )}
      {permFailed > 0 && (
        <Alert>
          {fmt(permFailed)} {permFailed === 1 ? "blob needs" : "blobs need"} attention — a
          configuration fault is blocking them. They won't retry until it's fixed.
        </Alert>
      )}

      <div className="cs-grid-2">
        <Card>
          <Stat
            value={fmt(status?.filesArchived ?? 0)}
            total={status && status.filesTotal > 0 ? fmt(status.filesTotal) : undefined}
            label="Files archived"
          />
        </Card>
        <Card>
          <Stat value={fmt(status?.blobsVerified ?? 0)} label="Blobs verified" />
        </Card>
        <Card>
          <Stat value={fmt(status?.sources.length ?? 0)} label="Source folders" />
        </Card>
      </div>

      <Card title="Current run">
        {run ? (
          <>
            <div className="cs-cluster" style={{ marginBottom: "var(--space-4)" }}>
              <Badge tone={run.active ? "accent" : "success"} icon={run.active ? "sync" : "check"}>
                {run.active ? "archiving" : "finished"}
              </Badge>
              <span className="cs-muted">
                {fmt(run.filesArchived)}
                {run.filesTotal !== null ? ` / ${fmt(run.filesTotal)}` : ""} files
                {run.blobsFailed ? ` · ${fmt(run.blobsFailed)} failed` : ""}
              </span>
            </div>
            {run.recent.length > 0 ? (
              <div>
                {run.recent.map((f) => (
                  <div className="cs-row" key={f.blob + f.file}>
                    <Icon name="description" size={20} />
                    <div className="cs-row-main">
                      <div className="cs-row-title">{f.file}</div>
                      <div className="cs-row-sub">{f.blob}</div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="cs-help">{run.active ? "Scanning…" : "Nothing was archived this run."}</p>
            )}
          </>
        ) : (
          <EmptyState icon="cloud_done" title="No backup running. Your vault is steady." />
        )}
      </Card>

      <Card title={`Failures${failures.length ? ` (${failures.length})` : ""}`}>
        {failures.length > 0 ? (
          <div>
            {failures.map((f, i) => (
              <div className="cs-row" key={f.blob + i}>
                <Badge tone={f.kind === "permanent" ? "danger" : "warning"}>{f.kind}</Badge>
                <div className="cs-row-main">
                  <div className="cs-row-title">{f.message}</div>
                  <div className="cs-row-sub">{f.blob}</div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState icon="verified" title="No failures. Everything that tried, landed." />
        )}
      </Card>
    </Page>
  );
};
