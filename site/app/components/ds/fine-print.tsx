/*
 * DS · FinePrint — reimplemented from the compiled DS bundle's API. Small muted
 * caption (~13px, tertiary ink). Accepts a style override for grid placement.
 */
import * as React from "react";

export type FinePrintProps = {
  children: React.ReactNode;
  style?: React.CSSProperties;
};

export function FinePrint({ children, style }: FinePrintProps) {
  return (
    <p
      style={{
        margin: "12px 0 0",
        font: "400 13px/1.6 var(--font-ui)",
        color: "var(--text-tertiary)",
        textWrap: "pretty",
        ...style,
      }}
    >
      {children}
    </p>
  );
}
