/*
 * DS · BrandMark — the ColdStorage ice-cube mark.
 *
 * The brand ships two designer-authored variants (light-bg / dark-bg). They are the
 * SAME geometry — diffed, the only deltas are the hexagon's stroke color, its stroke
 * weight, and the drop shadow's blur + opacity. So rather than carrying two near-identical
 * SVGs and swapping <img>s (double fetch, two files to keep in step), the geometry lives
 * here once and the four theme-varying values come from CSS custom properties that flip
 * under `.dark` — see brand-mark.css. SSOT for the mark; PILLAR3.
 *
 * Inlined (not an <img src>) so it inherits the theme with zero flash and zero request.
 *
 * Sizing: driven entirely by CSS (`width`/`height` on `.csf-brandmark`), so callers set
 * size in their own stylesheet rather than passing pixel props around.
 */
import "./brand-mark.css";
import * as React from "react";

export type BrandMarkProps = {
  /** Extra class for caller-side sizing/positioning. */
  className?: string;
  /**
   * Accessible name. Omit when the mark sits next to a visible "ColdStorage" wordmark
   * (the common case) — it is then decorative and gets aria-hidden instead.
   */
  title?: string;
};

export function BrandMark({ className, title }: BrandMarkProps) {
  // The mark renders more than once per page (nav + footer), and SVG filter refs are
  // document-global — so the id must be unique. useId is stable across SSR + hydration.
  const shadowId = `csf-brandmark-shadow-${React.useId()}`;

  return (
    <svg
      className={`csf-brandmark${className ? ` ${className}` : ""}`}
      viewBox="0 0 98 106"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      <defs>
        {/*
         * Shadow lives in SVG user units so it scales with the mark (a CSS
         * `filter: drop-shadow()` would be a fixed px size at every render size).
         * Its blur is fixed at the dark variant's stdDeviation=2 — light's 2 vs 1.5
         * is sub-pixel at every size this mark renders. The *visible* delta between
         * the two variants is opacity (0.25 → 0.6), and that flips via CSS.
         */}
        <filter id={shadowId}>
          <feDropShadow dy="2" stdDeviation="2" floodColor="#000000" className="csf-brandmark__shadow" />
        </filter>
      </defs>
      {/* Outer hexagon — the only themed element (stroke color + weight + shadow). */}
      <path
        className="csf-brandmark__hex"
        d="M48.8813 3.88135L91.8813 27.3813V74.3814L48.8813 97.8813L5.88135 74.3814V27.3813L48.8813 3.88135Z"
        strokeLinejoin="round"
        filter={`url(#${shadowId})`}
      />
      {/* Cube faces — identical across both variants. */}
      <path d="M48.8812 6.63257L89.9701 28.8315L48.8812 51.0304L7.79236 28.8315L48.8812 6.63257Z" fill="#FFFFFF" />
      <path d="M7.79236 28.8315L48.8812 51.0305V95.4283L7.79236 73.2294V28.8315Z" fill="#C1E4FB" />
      <path d="M89.9702 28.8315L48.8813 51.0305V95.4283L89.9702 73.2294V28.8315Z" fill="#99CFF0" />
    </svg>
  );
}
