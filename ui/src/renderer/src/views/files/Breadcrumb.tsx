/**
 * Drill-in breadcrumb — the browser's whole navigation model (like iOS Files / Explorer). Each crumb
 * is a jump target; the last is the current folder. Root is labeled "My Files", not "/".
 *
 * Every ancestor crumb is also a drag-to-move DROP target (Finder parity: dragging a row onto a crumb
 * moves it up/out), and holding over one SPRING-OPENS it mid-drag (useMoveDrag). The current crumb is
 * a disabled button, so it receives no drag events — and a drop there would be a no-op anyway (the
 * items already live in it).
 */
import { Fragment } from "react";
import { segments } from "./model.ts";
import type { MoveDrag } from "./useMoveDrag.ts";
import { Icon } from "../../ui/primitives.tsx";

export const Breadcrumb = ({
  dir,
  onNavigate,
  drag,
}: {
  dir: string;
  onNavigate: (dir: string) => void;
  drag: MoveDrag;
}): React.JSX.Element => {
  const segs = segments(dir);
  const crumbs = [{ name: "My Files", path: "" }, ...segs.map((name, i) => ({ name, path: segs.slice(0, i + 1).join("/") }))];

  return (
    <nav className="cs-crumbs" aria-label="Breadcrumb">
      {crumbs.map((c, i) => {
        const current = i === crumbs.length - 1;
        const cls = current ? "cs-crumb cs-crumb--current" : "cs-crumb";
        return (
          <Fragment key={c.path || "root"}>
            {i > 0 && (
              <span className="cs-crumb-sep">
                <Icon name="chevron_right" size={18} />
              </span>
            )}
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
          </Fragment>
        );
      })}
    </nav>
  );
};
