/*
 * DS · Badge — reimplemented from the compiled DS bundle's API. Small pill status
 * label: accent (iceberg) or success (green). Prop surface as consumed by vault-mock.
 */
import "./badge.css";
import * as React from "react";

export type BadgeProps = {
  tone: "accent" | "success";
  /** leading Material Symbols Rounded glyph name */
  icon?: string;
  children: React.ReactNode;
};

export function Badge({ tone, icon, children }: BadgeProps) {
  return (
    <span className={`csf-badge csf-badge--${tone}`}>
      {icon ? (
        <span className="csf-icon csf-badge__icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span>{children}</span>
    </span>
  );
}
