/*
 * DS · CtaPanel — reimplemented from the compiled DS bundle's API. Centered closing
 * panel on a raised frost surface: eyebrow · title · lead · CTA (children) · note.
 */
import "./cta-panel.css";
import * as React from "react";

/*
 * The head (eyebrow · title · lead) is optional: on `/download` the page's `<PageHero>` already
 * says all three in an `<h1>`, and the panel is there purely to hold the buttons. Everywhere
 * else the panel is a closing sign-off that introduces itself.
 */
export type CtaPanelProps = {
  eyebrow?: string;
  title?: string;
  lead?: string;
  note: string;
  /** the CTA button(s) */
  children: React.ReactNode;
};

export function CtaPanel({ eyebrow, title, lead, note, children }: CtaPanelProps) {
  return (
    <div className="csf-cta">
      {eyebrow ? <span className="csf-eyebrow">{eyebrow}</span> : null}
      {title ? <h2 className="csf-title csf-cta__title">{title}</h2> : null}
      {lead ? <p className="csf-lead csf-cta__lead">{lead}</p> : null}
      <div className="csf-cta__actions">{children}</div>
      <p className="csf-cta__note">{note}</p>
    </div>
  );
}
