/**
 * Layer-2 views: functional-but-UNSTYLED. The point is to exercise every command and reflect every
 * event end-to-end so layer 3 can skin these with the real design system (no thrown-away CSS). No
 * archive logic lives here — buttons call `api.request`, the screen renders the folded store state.
 */
import { useState } from "react";
import type { ColdstoreApi, Source } from "../../shared/ipc.ts";
import type { RestoreActivity } from "./state/reducer.ts";
import type { Store } from "./state/store.ts";
import { useAppState } from "./useStore.ts";

/** Fire-and-forget a command, surfacing any rejection. Threaded to child views. */
type Exec = (fn: () => Promise<unknown>) => void;

interface Props {
  api: ColdstoreApi;
  store: Store;
}

export const App = ({ api, store }: Props): React.JSX.Element => {
  const state = useAppState(store);
  const [cmdError, setCmdError] = useState<string | null>(null);

  const exec: Exec = (fn) => {
    setCmdError(null);
    void fn().catch((e: unknown) => setCmdError(e instanceof Error ? e.message : String(e)));
  };

  const { connection, status, run: progress, failures, restores, lastError } = state;
  const restoreList = Object.values(restores);

  return (
    <main>
      <h1>ColdStorage</h1>
      <p>
        connection: <b>{connection}</b>
        {status ? (status.running ? " · running" : status.paused ? " · paused" : " · idle") : ""}
      </p>

      {lastError && <p role="alert">daemon error: {lastError}</p>}
      {cmdError && <p role="alert">command failed: {cmdError}</p>}

      <section>
        <h2>Status</h2>
        {status ? (
          <ul>
            <li>files archived: {status.filesArchived} / {status.filesTotal}</li>
            <li>blobs verified: {status.blobsVerified}</li>
            <li>permanently failed blobs: {status.permanentlyFailedBlobs}</li>
            <li>paused: {String(status.paused)} · running: {String(status.running)}</li>
          </ul>
        ) : (
          <p>no snapshot yet…</p>
        )}
        <button onClick={() => exec(() => api.request("triggerNow"))}>Archive now</button>
        {status?.paused ? (
          <button onClick={() => exec(() => api.request("resume"))}>Resume</button>
        ) : (
          <button onClick={() => exec(() => api.request("pause"))}>Pause</button>
        )}
      </section>

      <Sources api={api} sources={status?.sources ?? []} exec={exec} />

      <section>
        <h2>Current run</h2>
        {progress ? (
          <>
            <p>
              {progress.active ? "archiving…" : "finished"} — {progress.filesArchived}
              {progress.filesTotal !== null ? ` / ${progress.filesTotal}` : ""} files
              {progress.blobsFailed !== null ? ` · ${progress.blobsFailed} blob(s) failed` : ""}
            </p>
            <ul>
              {progress.recent.map((f) => (
                <li key={f.blob + f.file}>
                  {f.file} → {f.blob}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p>no run this session.</p>
        )}
      </section>

      <section>
        <h2>Blob failures ({failures.length})</h2>
        <ul>
          {failures.map((f, i) => (
            <li key={f.blob + i}>
              [{f.kind}] {f.blob}: {f.message}
            </li>
          ))}
        </ul>
      </section>

      <Restore api={api} exec={exec} activities={restoreList} />
    </main>
  );
};

const Sources = ({
  api,
  sources,
  exec,
}: {
  api: ColdstoreApi;
  sources: Source[];
  exec: Exec;
}): React.JSX.Element => {
  const [path, setPath] = useState("");
  return (
    <section>
      <h2>Sources ({sources.length})</h2>
      <ul>
        {sources.map((s) => (
          <li key={s.id}>
            {s.path ?? s.id} <i>({s.kind})</i>{" "}
            <button onClick={() => exec(() => api.request("removeSource", { id: s.id }))}>remove</button>
          </li>
        ))}
      </ul>
      <input
        placeholder="/absolute/folder"
        value={path}
        onChange={(e) => setPath(e.target.value)}
      />
      <button
        disabled={!path.trim()}
        onClick={() => {
          exec(() => api.request("addSource", { path: path.trim() }));
          setPath("");
        }}
      >
        Add source
      </button>
    </section>
  );
};

const Restore = ({
  api,
  exec,
  activities,
}: {
  api: ColdstoreApi;
  exec: Exec;
  activities: RestoreActivity[];
}): React.JSX.Element => {
  const [file, setFile] = useState("");
  const [out, setOut] = useState("");
  return (
    <section>
      <h2>Restore</h2>
      <p>
        Idempotent: re-issue until the file lands (state `restored`). Glacier thaws can take hours; the
        reply quotes the wait.
      </p>
      <input placeholder="file id" value={file} onChange={(e) => setFile(e.target.value)} />
      <input placeholder="/absolute/out/path" value={out} onChange={(e) => setOut(e.target.value)} />
      <button
        disabled={!file.trim() || !out.trim()}
        onClick={() => exec(() => api.request("restore", { file: file.trim(), out: out.trim() }))}
      >
        Restore step
      </button>
      <ul>
        {activities.map((a) => (
          <li key={a.file}>
            {a.file}: {a.state}
            {a.tier ? ` (${a.tier})` : ""}
            {a.out ? ` → ${a.out}` : ""}
          </li>
        ))}
      </ul>
    </section>
  );
};
