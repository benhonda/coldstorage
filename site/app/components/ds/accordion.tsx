/*
 * DS · Accordion — reimplemented from the compiled DS bundle's API. Independent Q&A
 * disclosures (opening one never closes another) seeded by `defaultOpen`. Accessible
 * (button headers + aria-expanded, aria-controls). SSR-safe: initial render opens
 * `defaultOpen`, matching the server; every answer is in the DOM (collapsed via CSS,
 * never `hidden`/unmounted) so the panels can animate their height open and closed,
 * and the content survives no-JS.
 */
import "./accordion.css";
import * as React from "react";
import type { FaqItem } from "~/lib/marketing/content";

export type AccordionProps = {
  items: FaqItem[];
  defaultOpen?: number;
};

export function Accordion({ items, defaultOpen }: AccordionProps) {
  /** Every row is independent — a Set, not a single index, so opening one leaves the rest alone. */
  const [open, setOpen] = React.useState<ReadonlySet<number>>(
    () => new Set(defaultOpen === undefined ? [] : [defaultOpen]),
  );
  const baseId = React.useId();

  const toggle = (i: number) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(i)) next.add(i);
      return next;
    });

  return (
    <div className="csf-accordion">
      {items.map((it, i) => {
        const isOpen = open.has(i);
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
                onClick={() => toggle(i)}
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
              className={`csf-accordion__panel${isOpen ? " is-open" : ""}`}
              /* Collapsed panels stay rendered so height can animate; `inert` keeps them out
                 of the tab order and the a11y tree the way `hidden` used to. */
              inert={!isOpen}
            >
              <div className="csf-accordion__panel-inner">
                <p className="csf-accordion__a">{it.answer}</p>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
