/**
 * App-shell layout: the navigation Sidebar (transparent over the page glow) and the Page wrapper
 * (TopBar + scrolling content column) every view composes. Presentational — route state lives in App.
 */
import type { ReactNode } from "react";
import { Icon } from "./primitives.tsx";

export interface NavItem {
  id: string;
  label: string;
  icon: string;
  /** Disabled + reason — shown honestly, not hidden. */
  disabled?: boolean;
  hint?: string;
}

/** Navigation rail. The mark is a stand-in (Material snowflake on the iceberg tile) for the real
 * six-point frost crystal — swap in the brand SVG when it's exported from the DS. The `footer` slot
 * holds whatever the app pins to the foot (storage line, status, getting-back). */
export const Sidebar = ({
  items,
  active,
  onNavigate,
  footer,
  account,
}: {
  items: NavItem[];
  active: string;
  onNavigate: (id: string) => void;
  footer?: ReactNode;
  /** The pinned account card (very bottom, below the status footer) — multi-user installs only. */
  account?: ReactNode;
}): React.JSX.Element => (
  <aside className="cs-sidebar">
    <div className="cs-brand">
      <span className="cs-brand-mark">
        <Icon name="ac_unit" size={18} />
      </span>
      <span className="cs-brand-word">coldstorage</span>
    </div>
    <nav className="cs-nav">
      {items.map((it) => (
        <button
          key={it.id}
          type="button"
          className="cs-nav-item"
          aria-current={active === it.id ? "page" : undefined}
          disabled={it.disabled}
          title={it.hint}
          onClick={() => onNavigate(it.id)}
        >
          <Icon name={it.icon} size={22} />
          {it.label}
        </button>
      ))}
    </nav>
    <div className="cs-nav-spacer" />
    <div className="cs-foot">{footer}</div>
    {account}
  </aside>
);

/**
 * A view's main column: TopBar (title + actions) over the content area. The topbar is a single-line
 * bar on every page — same height, same padding, same title baseline — so the chrome reads identically
 * whether the title is a plain string or a breadcrumb node. Page-level intro copy lives in the body,
 * not the chrome, so a one-page subtitle can't desync the bar. `fill` swaps the stacked, max-width
 * content column for a full-height region the view lays out itself (the file browser).
 */
export const Page = ({
  title,
  actions,
  fill = false,
  children,
}: {
  title: ReactNode;
  actions?: ReactNode;
  fill?: boolean;
  children: ReactNode;
}): React.JSX.Element => (
  <main className="cs-main">
    <header className="cs-topbar">
      <div className="cs-topbar-lead">
        {typeof title === "string" ? <h1 className="cs-topbar-title">{title}</h1> : title}
      </div>
      {actions && <div className="cs-cluster">{actions}</div>}
    </header>
    <div className={fill ? "cs-page cs-page--fill" : "cs-page"}>{children}</div>
  </main>
);
