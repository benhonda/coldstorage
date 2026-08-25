/**
 * Drill-in breadcrumb (like iOS Files / Explorer) — sits in the browser's nav row beside Back / Forward
 * (history.ts). Each crumb is a jump target; the last is the current folder. Root is labeled "My Files".
 * Deep paths fold to `My Files › … › current` (model.ts `crumbsFor`); the `…` opens a menu of the folded
 * ancestors, shallowest first, each a jump target.
 *
 * Every visible ancestor crumb is also a drag-to-move DROP target (Finder parity: dragging a row onto a
 * crumb moves it up/out), and holding over one SPRING-OPENS it mid-drag (useMoveDrag). The current crumb
 * is a disabled button, so it receives no drag events — and a drop there would be a no-op anyway (the
 * items already live in it). Folded ancestors aren't drop targets: drop on root, or Back out first.
 */
import { Fragment, useState } from "react";
import { ContextMenu } from "./ContextMenu.tsx";
import { type Crumb, crumbsFor } from "./model.ts";
import type { MoveDrag } from "./useMoveDrag.ts";
import { Icon } from "../../ui/primitives.tsx";

const Sep = (): React.JSX.Element => (
  <span className="cs-crumb-sep">
    <Icon name="chevron_right" size={18} />
  </span>
);

export const Breadcrumb = ({
  dir,
  onNavigate,
  drag,
}: {
  dir: string;
  onNavigate: (dir: string) => void;
  drag: MoveDrag;
}): React.JSX.Element => {
  const { shown, folded } = crumbsFor(dir);
  // Where the folded-ancestors menu opens (under the `…`), or null when closed.
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);

  const crumb = (c: Crumb, current: boolean): React.JSX.Element => {
    const cls = current ? "cs-crumb cs-crumb--current" : "cs-crumb";
    return (
      <button
        type="button"
        className={!current && drag.isDropTarget(c.path) ? `${cls} cs-crumb--drop` : cls}
        aria-current={current ? "page" : undefined}
        disabled={current}
        onClick={() => onNavigate(c.path)}
        {...(current ? {} : drag.target(c.path))}
      >
        {c.name}
      </button>
    );
  };

  return (
    <nav className="cs-crumbs" aria-label="Breadcrumb">
      {shown.map((c, i) => (
        <Fragment key={c.path || "root"}>
          {i > 0 && <Sep />}
          {/* the `…` slot sits right after root whenever anything is folded */}
          {i === 1 && folded.length > 0 && (
            <>
              <button
                type="button"
                className="cs-crumb cs-crumb--fold"
                aria-label={`${folded.length} more folders`}
                aria-haspopup="menu"
                aria-expanded={menuAt !== null}
                onClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  setMenuAt({ x: r.left, y: r.bottom + 4 });
                }}
              >
                …
              </button>
              <Sep />
            </>
          )}
          {crumb(c, i === shown.length - 1)}
        </Fragment>
      ))}
      {menuAt && (
        <ContextMenu
          x={menuAt.x}
          y={menuAt.y}
          items={folded.map((c) => ({ label: c.name, icon: "folder", onClick: () => onNavigate(c.path) }))}
          onClose={() => setMenuAt(null)}
        />
      )}
    </nav>
  );
};
