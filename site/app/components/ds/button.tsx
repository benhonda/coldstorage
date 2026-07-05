/*
 * DS · Button — reimplemented from the compiled DS bundle's API (no upstream source;
 * see SPEC.md "Open decisions"). Pill control on the DS `--btn-*` tokens.
 * Prop surface kept exactly as the marketing sections consume it.
 */
import "./button.css";
import * as React from "react";

export type ButtonProps = {
  variant: "primary" | "ghost";
  size: "lg" | "sm";
  /** leading Material Symbols Rounded glyph name */
  icon?: string;
  onClick?: () => void;
  children: React.ReactNode;
};

export function Button({ variant, size, icon, onClick, children }: ButtonProps) {
  return (
    <button
      type="button"
      className={`csf-btn csf-btn--${variant} csf-btn--${size}`}
      onClick={onClick}
    >
      {icon ? (
        <span className="csf-icon csf-btn__icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span>{children}</span>
    </button>
  );
}
