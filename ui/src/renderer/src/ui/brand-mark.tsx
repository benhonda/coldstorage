/**
 * The ColdStorage ice-cube mark, inlined.
 *
 * Geometry is the designer-delivered `site/brand/logo-for-lightmode.svg`, verbatim — the same
 * artwork `task ui:icon:build` composites onto the app-icon tile, so the sidebar mark and the
 * app icon are the same cube. That SVG is the SSOT (PILLAR3); this file is a second renderer of
 * it, alongside the site's `app/components/ds/brand-mark.tsx`. Changing the mark means a new
 * drop in `site/brand/`, then this path list and that one.
 *
 * Inlined rather than an <img src>: it lives in the app shell, so no request and no flash.
 *
 * Light variant only, deliberately — the shell is light-only (`color-scheme: light` in
 * styles/tokens/colors.css) and the sidebar sits on the page glow. The dark-bg variant differs
 * in exactly four values (stroke colour/weight, shadow blur/opacity); wire it the day the shell
 * grows a dark theme, not before.
 *
 * Sizing is CSS-driven (`.cs-brandmark` in styles/app.css) so callers don't pass pixel props.
 */
import { useId } from "react";

/** The mark's own colours — brand internals, not DS tokens, and not theme-varying. */
const CUBE_TOP = "#FFFFFF";
const CUBE_LEFT = "#C1E4FB";
const CUBE_RIGHT = "#99CFF0";
const OUTLINE = "#4DA2DA";
const OUTLINE_WIDTH = 5.76271;

export const BrandMark = (): React.JSX.Element => {
  // SVG filter refs are document-global, so the id has to be unique per instance.
  const shadowId = `cs-brandmark-shadow-${useId()}`;

  return (
    <svg
      className="cs-brandmark"
      viewBox="0 0 98 106"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      /* Decorative: the "coldstorage" wordmark beside it is the accessible name. */
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        {/* The lift shadow lives in SVG user units so it scales with the mark — a CSS
            drop-shadow() would be a fixed pixel size at every render size. */}
        <filter id={shadowId}>
          <feDropShadow dy="2" stdDeviation="1.5" floodColor="#000000" floodOpacity="0.25" />
        </filter>
      </defs>
      <path
        d="M48.8813 3.88135L91.8813 27.3813V74.3814L48.8813 97.8813L5.88135 74.3814V27.3813L48.8813 3.88135Z"
        stroke={OUTLINE}
        strokeWidth={OUTLINE_WIDTH}
        strokeLinejoin="round"
        filter={`url(#${shadowId})`}
      />
      <path d="M48.8812 6.63257L89.9701 28.8315L48.8812 51.0304L7.79236 28.8315L48.8812 6.63257Z" fill={CUBE_TOP} />
      <path d="M7.79236 28.8315L48.8812 51.0305V95.4283L7.79236 73.2294V28.8315Z" fill={CUBE_LEFT} />
      <path d="M89.9702 28.8315L48.8813 51.0305V95.4283L89.9702 73.2294V28.8315Z" fill={CUBE_RIGHT} />
    </svg>
  );
};
