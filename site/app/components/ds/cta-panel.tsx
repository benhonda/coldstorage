/*
 * DS · CtaPanel — reimplemented from the compiled DS bundle's API. Centered closing
 * panel on a raised frost surface: eyebrow · title · lead · CTA (children) · note.
 */
import "./cta-panel.css";
import * as React from "react";

export type CtaPanelProps = {
  eyebrow: string;
  title: string;
  lead: string;
  note: string;
  /** the CTA button(s) */
  children: React.ReactNode;
};

export function CtaPanel({ eyebrow, title, lead, note, children }: CtaPanelProps) {
  return (
    <div className="csf-cta">
      <span className="csf-eyebrow">{eyebrow}</span>
      <h2 className="csf-title csf-cta__title">{title}</h2>
      <p className="csf-lead csf-cta__lead">{lead}</p>
      <div className="csf-cta__actions">{children}</div>
      <p className="csf-cta__note">{note}</p>
    </div>
  );
}
