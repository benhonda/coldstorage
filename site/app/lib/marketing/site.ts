/*
 * Small marketing site helpers — ported from the upstream `shared/site-common.jsx`
 * site helpers, made SSR-safe (client-only APIs deferred to effects).
 */
import * as React from "react";

/** Smooth-scroll to an in-page anchor, offset for the sticky nav. */
export function csScrollTo(id: string): void {
  const el = document.getElementById(id);
  if (!el) return;
  const top = el.getBoundingClientRect().top + window.scrollY - 88;
  window.scrollTo({ top, behavior: "smooth" });
}

/** True once the page has scrolled past the hero lip — drives the nav's solid state.
 *  SSR-safe: false until mounted. */
export function useSolidNav(): boolean {
  const [solid, setSolid] = React.useState(false);
  React.useEffect(() => {
    const onScroll = () => setSolid(window.scrollY > 24);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  return solid;
}
