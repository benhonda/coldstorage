/*
 * DS · Button — reimplemented from the compiled DS bundle's API (no upstream source;
 * see SPEC.md "Open decisions"). Pill control on the DS `--btn-*` tokens.
 * Prop surface kept exactly as the marketing sections consume it.
 */
import "./button.css";
import * as React from "react";

export type ButtonProps = {
  variant: "primary" | "secondary" | "ghost";
  size: "lg" | "sm";
  /** leading Material Symbols Rounded glyph name */
  icon?: string;
  /** When set, the button renders as an anchor navigating here (e.g. the `/download` route). */
  href?: string;
  /**
   * Native button type. Defaults to `"button"` so a Button dropped inside a form can't submit
   * it by accident; the contact form sets `"submit"` deliberately. Ignored when `href` is set.
   */
  type?: "button" | "submit";
  /** Greys the control and blocks clicks — the contact form uses it while a send is in flight. */
  disabled?: boolean;
  onClick?: () => void;
  children: React.ReactNode;
};

export function Button({
  variant,
  size,
  icon,
  href,
  type = "button",
  disabled = false,
  onClick,
  children,
}: ButtonProps) {
  const className = `csf-btn csf-btn--${variant} csf-btn--${size}`;
  const inner = (
    <>
      {icon ? (
        <span className="csf-icon csf-btn__icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span>{children}</span>
    </>
  );

  // A plain anchor (not RR's <Link>) is deliberate: `/download` is a resource route that
  // 302s off-site, so we want a real document navigation, not a client-side route change.
  if (href) {
    return (
      <a className={className} href={href} onClick={onClick}>
        {inner}
      </a>
    );
  }

  return (
    <button type={type} className={className} onClick={onClick} disabled={disabled}>
      {inner}
    </button>
  );
}
