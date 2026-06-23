/**
 * Sources — the folders coldstorage watches and backs up. List + add/remove over the daemon registry
 * (the journal-backed SSOT; changes survive restart). A native folder picker (main-process
 * dialog.showOpenDialog) is a follow-up; for now the path is typed, matching the control command.
 */
import { useState } from "react";
import type { Source } from "../../../shared/ipc.ts";
import { Button, Card, EmptyState, Field, Icon, IconButton } from "../ui/primitives.tsx";
import { Page } from "../ui/layout.tsx";
import type { ViewProps } from "./types.ts";

export const SourcesView = ({
  api,
  exec,
  sources,
}: ViewProps & { sources: Source[] }): React.JSX.Element => {
  const [path, setPath] = useState("");

  const add = (): void => {
    const trimmed = path.trim();
    if (!trimmed) return;
    exec(() => api.request("addSource", { path: trimmed }));
    setPath("");
  };

  return (
    <Page title="Sources" subtitle="Folders coldstorage watches and backs up.">
      <Card title={`Watched folders${sources.length ? ` (${sources.length})` : ""}`}>
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
                  label={`Remove ${s.path ?? s.id}`}
                  onClick={() => exec(() => api.request("removeSource", { id: s.id }))}
                />
              </div>
            ))}
          </div>
        ) : (
          <EmptyState icon="create_new_folder" title="No folders yet. Add one to start backing up." />
        )}
      </Card>

      <Card title="Add a folder">
        <div className="cs-stack">
          <Field
            label="Folder path"
            placeholder="/Users/you/Pictures"
            value={path}
            mono
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") add();
            }}
          />
          <Button variant="primary" icon="add" disabled={!path.trim()} onClick={add}>
            Add folder
          </Button>
        </div>
      </Card>
    </Page>
  );
};
