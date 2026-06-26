/**
 * Folder picker tree — Google-Drive style: browse the drive one level at a time. Every row is a folder
 * you can **select** as the target; a folder with sub-folders also shows a **chevron to drill in**. A
 * compact breadcrumb climbs back up, and the level you're in is itself a selectable target ("this
 * folder"). Drilling keeps each level short, so it scales to a deep/wide tree without a giant flat list.
 *
 * Shared by the move dialog and the watched-folder destination picker. Controlled: `value` is the chosen
 * vault-relative dir ("" = My Files root); `onChange` sets it. `isDisabled` blocks selecting/entering
 * certain dirs (e.g. the folders being moved — you can't move them into themselves).
 */
import { Fragment, useState } from "react";
import type { ArchivedFile, FolderRow } from "./model.ts";
import { allFolderPaths, baseName, childrenOf, parentOf, segments } from "./model.ts";
import { Icon } from "../../ui/primitives.tsx";

export const FolderTree = ({
  files,
  virtualFolders,
  value,
  onChange,
  isDisabled,
}: {
  files: readonly ArchivedFile[];
  virtualFolders: readonly string[];
  value: string;
  onChange: (dir: string) => void;
  isDisabled?: (dir: string) => boolean;
}): React.JSX.Element => {
  // Browse level — start where the current selection lives, so it's visible on open.
  const [dir, setDir] = useState(value ? parentOf(value) : "");

  const folderPaths = allFolderPaths(files, virtualFolders);
  const hasSub = (p: string): boolean => folderPaths.some((fp) => fp.startsWith(`${p}/`));
  const children = childrenOf(files, dir, virtualFolders).filter((r): r is FolderRow => r.type === "folder");

  const crumbs = [
    { name: "My Files", path: "" },
    ...segments(dir).map((name, i) => ({ name, path: segments(dir).slice(0, i + 1).join("/") })),
  ];

  const row = (path: string, name: string, icon: string, drillable: boolean): React.JSX.Element => {
    const disabled = isDisabled?.(path) ?? false;
    const selected = value === path;
    return (
      <div key={path || "root"} className={selected ? "cs-treerow cs-treerow--on" : "cs-treerow"}>
        <button type="button" className="cs-treerow-pick" disabled={disabled} onClick={() => onChange(path)}>
          <Icon name={icon} size={20} />
          <span className="cs-treerow-name">{name}</span>
          {selected && <Icon name="check" size={20} />}
        </button>
        {drillable && (
          <button
            type="button"
            className="cs-treerow-into"
            disabled={disabled}
            aria-label={`Open ${name}`}
            onClick={() => setDir(path)}
          >
            <Icon name="chevron_right" size={20} />
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="cs-foldertree">
      <div className="cs-treecrumbs">
        {crumbs.map((c, i) => (
          <Fragment key={c.path || "root"}>
            {i > 0 && <Icon name="chevron_right" size={16} />}
            <button
              type="button"
              className="cs-treecrumb"
              disabled={i === crumbs.length - 1}
              onClick={() => setDir(c.path)}
            >
              {c.name}
            </button>
          </Fragment>
        ))}
      </div>
      <div className="cs-treelist">
        {/* the level you're in is a valid target ("put it here") */}
        {row(dir, dir ? baseName(dir) : "My Files", dir ? "folder_open" : "home", false)}
        {children.map((f) => row(f.path, f.name, "folder", hasSub(f.path)))}
        {children.length === 0 && (
          <p className="cs-help" style={{ padding: "var(--space-2) var(--space-3)" }}>
            No folders inside.
          </p>
        )}
      </div>
    </div>
  );
};
