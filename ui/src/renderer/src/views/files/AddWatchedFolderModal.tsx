/**
 * Add-a-watched-folder dialog — the whole action in one place, on the same modal grammar as the
 * request-a-copy dialog: a plain lead line, then two matching `cs-folderpick` rows — the folder on disk
 * (native OS picker) and where it appears in My Files. The destination opens an inline {@link FolderTree}
 * (the shared Google-Drive-style drill-in picker, also used by the move dialog). The watched folder keeps
 * its own name; the destination just nests it (pick "Backups" → "Backups/<name>"). Destination defaults
 * to the top level, so the common case is choose-folder → Add.
 */
import { useState } from "react";
import type { ArchivedFile } from "./model.ts";
import { baseName, joinPath } from "./model.ts";
import { FolderTree } from "./FolderTree.tsx";
import { Button, Modal } from "../../ui/primitives.tsx";

export const AddWatchedFolderModal = ({
  files,
  virtualFolders,
  chooseFolder,
  onAdd,
  onClose,
}: {
  files: readonly ArchivedFile[];
  virtualFolders: readonly string[];
  /** The native (OS) folder picker for the source on disk. */
  chooseFolder: (defaultPath?: string) => Promise<string | null>;
  /** Commit: the absolute disk path + the vault-relative location it lands at. */
  onAdd: (path: string, mountPath: string) => void;
  onClose: () => void;
}): React.JSX.Element => {
  const [srcPath, setSrcPath] = useState("");
  const [destDir, setDestDir] = useState(""); // "" = top level of the drive
  const [choosingDest, setChoosingDest] = useState(false);

  const pickSource = (): void => {
    void chooseFolder(srcPath || undefined).then((picked) => picked && setSrcPath(picked));
  };

  const destLabel = destDir ? `My Files / ${destDir.split("/").join(" / ")}` : "My Files";

  return (
    <Modal
      title="Add a watched folder"
      icon="create_new_folder"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon="add"
            disabled={!srcPath}
            onClick={() => srcPath && onAdd(srcPath, joinPath(destDir, baseName(srcPath)))}
          >
            Add
          </Button>
        </>
      }
    >
      <div className="cs-quote">
        <p className="cs-quote-lead">
          Keep a folder on your Mac backed up automatically. Its files show in My Files and stay current as
          they change.
        </p>

        <div className="cs-folderpick">
          <div className="cs-folderpick-info">
            <div className="cs-folderpick-label">Folder to watch</div>
            <div className="cs-folderpick-path">{srcPath || "No folder chosen yet"}</div>
          </div>
          <Button variant="secondary" size="sm" icon="folder_open" onClick={pickSource}>
            Choose…
          </Button>
        </div>

        <div className="cs-folderpick">
          <div className="cs-folderpick-info">
            <div className="cs-folderpick-label">Where it appears in My Files</div>
            <div className="cs-folderpick-path">{destLabel}</div>
          </div>
          <Button
            variant="secondary"
            size="sm"
            icon={choosingDest ? "expand_less" : "drive_file_move"}
            onClick={() => setChoosingDest((v) => !v)}
          >
            {choosingDest ? "Done" : "Choose…"}
          </Button>
        </div>

        {choosingDest && (
          <FolderTree files={files} virtualFolders={virtualFolders} value={destDir} onChange={setDestDir} />
        )}

        <p className="cs-note">
          It keeps its own name{srcPath ? ` — “${baseName(srcPath)}”` : ""}. New and changed files upload on
          their own; you can pause or remove it anytime.
        </p>
      </div>
    </Modal>
  );
};
