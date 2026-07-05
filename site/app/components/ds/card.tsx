/*
 * DS · Card — reimplemented from the compiled DS bundle's API. Padded rounded frost
 * surface with a hairline border and the soft card shadow.
 */
import "./card.css";
import * as React from "react";

export type CardProps = { children: React.ReactNode };

export function Card({ children }: CardProps) {
  return <div className="csf-card">{children}</div>;
}
