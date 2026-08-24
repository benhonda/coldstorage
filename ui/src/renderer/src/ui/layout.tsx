/**
 * App-shell layout: the navigation Sidebar (transparent over the page glow) and the Page wrapper
 * (TopBar + scrolling content column) every view composes. Presentational — route state lives in App.
 */
import type { ReactNode } from "react";
import { BrandMark } from "./brand-mark.tsx";
import { Icon } from "./primitives.tsx";

export interface NavItem {
  id: string;
  label: string;
  icon: string;
  /** Disabled + reason — shown honestly, not hidden. */
  disabled?: boolean;
  hint?: string;
  /** A count pinned to the right of the label — live work on that page (e.g. downloads in flight). Falsy
   * or zero renders nothing, so the rail is quiet when there's nothing to say. This is where an ambient
   * count belongs: it sits ON the page that explains it, one click from the detail, instead of floating in
   * the sidebar foot as a popover with nowhere to go. */
  badge?: number;
}

/** Navigation rail. The `footer` slot holds whatever the app pins to the foot (storage line,
 * status, getting-back). */
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
      <BrandMark />
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
          <span className="cs-nav-label">{it.label}</span>
          {it.badge ? (
            <span className="cs-nav-badge" aria-label={`${it.badge} in progress`}>
              {it.badge}
            </span>
          ) : null}
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
 * not the chrome, so a one-page subtitle can't desync the bar. `subnav` is a second chrome row under
 * the title (Settings' General | Account strip) — part of the header, so it stays put while the body
 * scrolls. `fill` swaps the stacked, max-width content column for a full-height region the view lays
 * out itself (the file browser).
 */
export const Page = ({
  title,
  actions,
  subnav,
  fill = false,
  children,
}: {
  title: ReactNode;
  actions?: ReactNode;
  subnav?: ReactNode;
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
    {subnav && <div className="cs-topbar-subnav">{subnav}</div>}
    <div className={fill ? "cs-page cs-page--fill" : "cs-page"}>{children}</div>
  </main>
);
