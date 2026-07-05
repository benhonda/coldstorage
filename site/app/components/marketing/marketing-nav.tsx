/*
 * MarketingNav — sticky top bar: wordmark left, in-page links, primary CTA. A fresh
 * stack component (no upstream source — the bundle's nav was compiled-only; see SPEC.md).
 * `solid` (fed from useSolidNav) frosts + borders the bar once the page scrolls past the
 * hero lip. In-page links smooth-scroll via csScrollTo; SSR-safe (browser APIs in handlers).
 */
import "./marketing-nav.css";
import * as React from "react";
import { Button } from "~/components/ds/button";
import { csScrollTo } from "~/lib/marketing/site";

type NavLink = { label: string; href: string };

export type MarketingNavProps = {
  links: NavLink[];
  cta: { label: string; href: string };
  solid: boolean;
};

export function MarketingNav({ links, cta, solid }: MarketingNavProps) {
  const onAnchor = (e: React.MouseEvent<HTMLAnchorElement>, href: string) => {
    if (href.startsWith("#")) {
      e.preventDefault();
      csScrollTo(href.slice(1));
    }
  };

  const toTop = (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <header className={`csf-mktnav${solid ? " is-solid" : ""}`}>
      <div className="csf-mktnav__inner csf-container">
        <a className="csf-mktnav__brand" href="#top" onClick={toTop}>
          <span className="csf-icon" aria-hidden="true">
            ac_unit
          </span>
          <span className="csf-mktnav__word">ColdStorage</span>
        </a>
        <nav className="csf-mktnav__links" aria-label="Primary">
          {links.map((l) => (
            <a
              key={l.href}
              className="csf-mktnav__link"
              href={l.href}
              onClick={(e) => onAnchor(e, l.href)}
            >
              {l.label}
            </a>
          ))}
        </nav>
        <div className="csf-mktnav__cta">
          <Button variant="primary" size="sm" icon="download" href={cta.href}>
            {cta.label}
          </Button>
        </div>
      </div>
    </header>
  );
}
