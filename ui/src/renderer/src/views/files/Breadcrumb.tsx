/**
 * Drill-in breadcrumb — the browser's whole navigation model (like iOS Files / Explorer). Each crumb
 * is a jump target; the last is the current folder. Root is labeled "My Files", not "/".
 */
import { Fragment } from "react";
import { segments } from "./model.ts";
import { Icon } from "../../ui/primitives.tsx";

export const Breadcrumb = ({
  dir,
  onNavigate,
}: {
  dir: string;
  onNavigate: (dir: string) => void;
}): React.JSX.Element => {
  const segs = segments(dir);
  const crumbs = [{ name: "My Files", path: "" }, ...segs.map((name, i) => ({ name, path: segs.slice(0, i + 1).join("/") }))];

  return (
    <nav className="cs-crumbs" aria-label="Breadcrumb">
      {crumbs.map((c, i) => {
        const current = i === crumbs.length - 1;
        return (
          <Fragment key={c.path || "root"}>
            {i > 0 && (
              <span className="cs-crumb-sep">
                <Icon name="chevron_right" size={18} />
              </span>
            )}
            <button
              type="button"
              className={current ? "cs-crumb cs-crumb--current" : "cs-crumb"}
              aria-current={current ? "page" : undefined}
              disabled={current}
              onClick={() => onNavigate(c.path)}
            >
              {c.name}
            </button>
          </Fragment>
        );
      })}
    </nav>
  );
};
