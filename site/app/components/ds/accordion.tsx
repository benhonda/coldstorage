/*
 * DS · Accordion — reimplemented from the compiled DS bundle's API. One-open Q&A
 * disclosure seeded by `defaultOpen`. Accessible (button headers + aria-expanded,
 * aria-controls). SSR-safe: initial render opens `defaultOpen`, matching the server;
 * every answer is in the DOM (collapsed, not removed) so content survives no-JS.
 */
import "./accordion.css";
import * as React from "react";
import type { FaqItem } from "~/lib/marketing/content";

export type AccordionProps = {
  items: FaqItem[];
  defaultOpen?: number;
};

export function Accordion({ items, defaultOpen }: AccordionProps) {
  const [open, setOpen] = React.useState<number | null>(defaultOpen ?? null);
  const baseId = React.useId();

  return (
    <div className="csf-accordion">
      {items.map((it, i) => {
        const isOpen = open === i;
        const panelId = `${baseId}-panel-${i}`;
        const headId = `${baseId}-head-${i}`;
        return (
          <div key={it.question} className="csf-accordion__item">
            <h3 className="csf-accordion__h">
              <button
                type="button"
                id={headId}
                className="csf-accordion__head"
                aria-expanded={isOpen}
                aria-controls={panelId}
                onClick={() => setOpen(isOpen ? null : i)}
              >
                <span className="csf-accordion__q">{it.question}</span>
                <span
                  className={`csf-icon csf-accordion__chev${isOpen ? " is-open" : ""}`}
                  aria-hidden="true"
                >
                  expand_more
                </span>
              </button>
            </h3>
            <div
              id={panelId}
              role="region"
              aria-labelledby={headId}
              className="csf-accordion__panel"
              hidden={!isOpen}
            >
              <p className="csf-accordion__a">{it.answer}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}
