/**
 * App-shell layout: the navigation Sidebar (transparent over the page glow) and the Page wrapper
 * (TopBar + scrolling content column) every view composes. Presentational — route state lives in App.
 */
import type { ReactNode } from "react";
import type { ConnectionState } from "../../../shared/ipc.ts";
import { Icon } from "./primitives.tsx";

export interface NavItem {
  id: string;
  label: string;
  icon: string;
  /** Disabled + reason (e.g. browse is blocked on the R2 index) — shown honestly, not hidden. */
  disabled?: boolean;
  hint?: string;
}

const CONN_COPY: Record<ConnectionState, { dot: string; label: string }> = {
  connected: { dot: "cs-dot--connected", label: "Connected to daemon" },
  connecting: { dot: "cs-dot--connecting", label: "Connecting…" },
  disconnected: { dot: "cs-dot--disconnected", label: "Daemon offline" },
};

/** Navigation rail. The mark is a stand-in (Material snowflake on the iceberg tile) for the real
 * six-point frost crystal — swap in the brand SVG when it's exported from the DS. */
export const Sidebar = ({
  items,
  active,
  onNavigate,
  connection,
}: {
  items: NavItem[];
  active: string;
  onNavigate: (id: string) => void;
  connection: ConnectionState;
}): React.JSX.Element => {
  const conn = CONN_COPY[connection];
  return (
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
      <div className="cs-conn">
        <span className={`cs-dot ${conn.dot}`} />
        {conn.label}
      </div>
    </aside>
  );
};

/** A view's main column: TopBar (title + actions) over a scrolling content area. */
export const Page = ({
  title,
  subtitle,
  actions,
  children,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
}): React.JSX.Element => (
  <main className="cs-main">
    <header className="cs-topbar">
      <div>
        <h1 className="cs-topbar-title">{title}</h1>
        {subtitle && <p className="cs-topbar-sub">{subtitle}</p>}
      </div>
      {actions && <div className="cs-cluster">{actions}</div>}
    </header>
    <div className="cs-page">{children}</div>
  </main>
);
