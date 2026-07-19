/*
 * MarketingFooter — multi-column link footer. A fresh stack component (no upstream
 * source — bundle-only; see SPEC.md). Props are the typed `FOOTER` shape from content.ts.
 * In-page (#) links smooth-scroll via csScrollTo; the rest render as plain anchors.
 */
import "./marketing-footer.css";
import * as React from "react";
import { BrandMark } from "~/components/ds/brand-mark";
import type { Footer } from "~/lib/marketing/content";
import { csScrollTo } from "~/lib/marketing/site";

export function MarketingFooter({ tagline, columns, legal, copyright }: Footer) {
  const onAnchor = (e: React.MouseEvent<HTMLAnchorElement>, href?: string) => {
    if (href && href.startsWith("#")) {
      e.preventDefault();
      csScrollTo(href.slice(1));
    }
  };

  return (
    <footer className="csf-footer">
      <div className="csf-container csf-footer__inner">
        <div className="csf-footer__brand">
          <div className="csf-footer__word">
            <BrandMark className="csf-footer__mark" />
            ColdStorage
          </div>
          <p className="csf-footer__tagline">{tagline}</p>
        </div>

        <div className="csf-footer__cols">
          {columns.map((col) => (
            <div key={col.heading} className="csf-footer__col">
              <div className="csf-footer__heading">{col.heading}</div>
              <ul className="csf-footer__list">
                {col.links.map((link) => (
                  <li key={link.label}>
                    <a
                      className="csf-footer__link"
                      href={link.href ?? "#"}
                      onClick={(e) => onAnchor(e, link.href)}
                    >
                      {link.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>

      <div className="csf-container csf-footer__bar">
        <span className="csf-footer__copy">{copyright}</span>
        <div className="csf-footer__legal">
          {legal.map((link) => (
            <a
              key={link.label}
              className="csf-footer__link"
              href={link.href ?? "#"}
              onClick={(e) => onAnchor(e, link.href)}
            >
              {link.label}
            </a>
          ))}
        </div>
      </div>
    </footer>
  );
}
