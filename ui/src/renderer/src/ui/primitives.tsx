/**
 * coldstorage Design System primitives — native React 19 port (not the DS's UMD bundle, which targets
 * Claude Design's CDN/Babel runtime). Pure presentational components bound to the vendored token vars
 * (../styles); they hold no app state. Voice rules live in the DS guide: sentence case, no exclamation
 * marks, no emoji — enforced by the copy passed in, not here.
 */
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";

/** Material Symbols Rounded glyph (filled by default — the brand icon style). */
export const Icon = ({
  name,
  size,
  outline = false,
}: {
  name: string;
  size?: number;
  outline?: boolean;
}): React.JSX.Element => (
  <span
    className={outline ? "csf-icon csf-icon--outline" : "csf-icon"}
    style={size ? { fontSize: size } : undefined}
    aria-hidden="true"
  >
    {name}
  </span>
);

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md" | "lg";

/** Pill button in four fills. `primary` = solid iceberg, the single main action of a view. */
export const Button = ({
  variant = "secondary",
  size = "md",
  icon,
  full = false,
  className,
  children,
  ...rest
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: string;
  full?: boolean;
} & ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element => {
  const classes = [
    "cs-btn",
    `cs-btn--${variant}`,
    size !== "md" ? `cs-btn--${size}` : "",
    full ? "cs-btn--full" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button className={classes} {...rest}>
      {icon && <Icon name={icon} size={20} />}
      {children}
    </button>
  );
};

/** Circular icon-only button for chrome actions (back, remove, overflow). `label` is the a11y name. */
export const IconButton = ({
  icon,
  label,
  className,
  ...rest
}: {
  icon: string;
  label: string;
} & ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element => (
  <button className={["cs-iconbtn", className ?? ""].filter(Boolean).join(" ")} aria-label={label} {...rest}>
    <Icon name={icon} size={20} />
  </button>
);

/** Top-level surface panel. Elevation by shadow + hairline; `raised` for nested, `flush` for full-bleed. */
export const Card = ({
  title,
  action,
  description,
  raised = false,
  flush = false,
  className,
  children,
}: {
  title?: ReactNode;
  action?: ReactNode;
  /** Supporting line under the title — part of the header block, not the body, so its spacing is
   * standardized (never a hand-set margin on an ad-hoc `<p>`). Sits below the title/action row,
   * full-width. */
  description?: ReactNode;
  raised?: boolean;
  flush?: boolean;
  className?: string;
  children: ReactNode;
}): React.JSX.Element => {
  const classes = [
    "cs-card",
    raised ? "cs-card--raised" : "",
    flush ? "cs-card--flush" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <section className={classes}>
      {(title || action) && (
        <header className="cs-card-head">
          {title && <h2 className="cs-card-title">{title}</h2>}
          {action}
        </header>
      )}
      {description && <p className="cs-card-desc">{description}</p>}
      {children}
    </section>
  );
};

/** A big reassuring number with a quiet label. `total` is rendered dimmer (e.g. "1,204 / 1,204"). */
export const Stat = ({
  value,
  total,
  label,
}: {
  value: ReactNode;
  total?: ReactNode;
  label: string;
}): React.JSX.Element => (
  <div>
    <div className="cs-stat-value">
      {value}
      {total != null && <span className="cs-stat-total"> / {total}</span>}
    </div>
    <div className="cs-stat-label">{label}</div>
  </div>
);

/**
 * Sub-page tab strip (a proper `tablist`) — the text-forward segmented control over a view's subpages
 * (e.g. Settings › General | Account). Generic over the tab id so `onChange` hands back the caller's
 * union, never a bare string. Arrow keys move selection (automatic activation) with focus following
 * the newly active tab (roving tabindex).
 */
export const Tabs = <T extends string>({
  tabs,
  active,
  onChange,
  label,
}: {
  tabs: readonly { id: T; label: string }[];
  active: T;
  onChange: (id: T) => void;
  /** Accessible name for the tablist (e.g. "Settings sections"). */
  label: string;
}): React.JSX.Element => {
  const strip = useRef<HTMLDivElement>(null);
  const move = (dir: 1 | -1): void => {
    const i = tabs.findIndex((t) => t.id === active);
    const next = tabs[(i + dir + tabs.length) % tabs.length];
    if (!next || next.id === active) return;
    onChange(next.id);
    strip.current?.querySelector<HTMLButtonElement>(`[data-tab="${next.id}"]`)?.focus();
  };
  return (
    <div
      ref={strip}
      className="cs-subnav"
      role="tablist"
      aria-label={label}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight") move(1);
        else if (e.key === "ArrowLeft") move(-1);
      }}
    >
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          data-tab={t.id}
          aria-selected={active === t.id}
          tabIndex={active === t.id ? 0 : -1}
          className="cs-subnav-tab"
          onClick={() => onChange(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
};

type BadgeTone = "neutral" | "accent" | "success" | "danger" | "warning";

/** 24px status pill — a state, count or delta. (For a descriptive label, the DS uses a Chip.) */
export const Badge = ({
  tone = "neutral",
  icon,
  children,
}: {
  tone?: BadgeTone;
  icon?: string;
  children: ReactNode;
}): React.JSX.Element => (
  <span className={`cs-badge cs-badge--${tone}`}>
    {icon && <Icon name={icon} size={14} />}
    {children}
  </span>
);

/**
 * Placeholder for a figure that hasn't arrived yet — a quietly pulsing block sized to the text it
 * stands in for. This exists to keep "still loading" from reading as "zero" or "broken": a storage
 * figure that renders blank while the daemon socket is still dialing is indistinguishable from an
 * empty vault, which is the more alarming of the two readings and the wrong one.
 *
 * Use ONLY for genuinely-pending data. A value that is known-absent should say so in words.
 */
export const Skeleton = ({
  width,
  height = 12,
  label = "Loading",
}: {
  /** CSS width — match the shape of the real value (e.g. "9ch" for "6 GB of 25 GB"). */
  width: string;
  height?: number;
  /** Screen-reader text; the block itself is decorative. */
  label?: string;
}): React.JSX.Element => (
  <span className="cs-skeleton" style={{ width, height }} role="status" aria-label={label} />
);

/** Detail row — label left, value flush right. Pass `onClick` to make it an editable (button) row. */
export const KeyValueRow = ({
  label,
  value,
  accent = false,
  icon,
  onClick,
}: {
  label: ReactNode;
  value: ReactNode;
  accent?: boolean;
  icon?: string;
  onClick?: () => void;
}): React.JSX.Element => {
  const inner = (
    <>
      <span className="cs-kv-label">{label}</span>
      <span className={accent ? "cs-kv-value cs-kv-value--accent" : "cs-kv-value"}>
        {value}
        {icon && <Icon name={icon} size={18} />}
      </span>
    </>
  );
  return onClick ? (
    <button type="button" className="cs-kv" onClick={onClick}>
      {inner}
    </button>
  ) : (
    <div className="cs-kv">{inner}</div>
  );
};

/** Centered empty state — one calm sentence, no illustration. */
/** Centered empty state: icon + title, with an optional supporting line and a call-to-action (e.g. the
 * Add button) folded in, so the empty case is self-contained instead of leaning on surrounding chrome. */
export const EmptyState = ({
  icon,
  title,
  description,
  action,
}: {
  icon: string;
  title: string;
  description?: string;
  action?: ReactNode;
}): React.JSX.Element => (
  <div className="cs-empty">
    <Icon name={icon} outline />
    <div className="cs-empty-copy">
      <p className="cs-empty-title">{title}</p>
      {description && <p className="cs-empty-text">{description}</p>}
    </div>
    {action && <div className="cs-empty-action">{action}</div>}
  </div>
);

/** Borderless filled field with the label floating inside above the value (never outside). */
export const Field = ({
  label,
  error,
  mono = false,
  className,
  ...rest
}: {
  label: string;
  error?: string;
  mono?: boolean;
} & InputHTMLAttributes<HTMLInputElement>): React.JSX.Element => (
  <label className={["cs-field", error ? "cs-field--error" : "", className ?? ""].filter(Boolean).join(" ")}>
    <span className="cs-field-label">{label}</span>
    <input className={mono ? "cs-field-input cs-mono" : "cs-field-input"} {...rest} />
    {error && <span className="cs-field-error">{error}</span>}
  </label>
);

/** Calm, honest problem banner — names the issue plainly. */
export const Alert = ({ children, icon = "error" }: { children: ReactNode; icon?: string }): React.JSX.Element => (
  <div className="cs-alert" role="alert">
    <Icon name={icon} size={20} />
    <span>{children}</span>
  </div>
);

/** Removable label chip — a "don't back up" pattern, a tag. Pass `onRemove` to show the ✕. */
export const Chip = ({
  children,
  mono = false,
  onRemove,
}: {
  children: ReactNode;
  mono?: boolean;
  onRemove?: () => void;
}): React.JSX.Element => (
  <span className={mono ? "cs-chip cs-mono" : "cs-chip"}>
    {children}
    {onRemove && (
      <button type="button" className="cs-chip-x" aria-label="Remove" onClick={onRemove}>
        <Icon name="close" size={14} />
      </button>
    )}
  </span>
);

/**
 * Centered modal over a scrim — for the deliberate moments (a request-back quote, a delete confirm).
 * Closes on Escape or scrim click; the panel stops propagation so inner clicks don't dismiss. `footer`
 * holds the actions (primary action rightmost, DS convention).
 */
export const Modal = ({
  title,
  icon,
  onClose,
  footer,
  children,
}: {
  title: string;
  icon?: string;
  onClose: () => void;
  footer?: ReactNode;
  children: ReactNode;
}): React.JSX.Element => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div className="cs-modal-scrim" onClick={onClose}>
      <div
        className="cs-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="cs-modal-head">
          {icon && <Icon name={icon} size={22} />}
          <h2 className="cs-modal-title">{title}</h2>
          <IconButton icon="close" label="Close" className="cs-modal-x" onClick={onClose} />
        </header>
        <div className="cs-modal-body">{children}</div>
        {footer && <footer className="cs-modal-foot">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
};
