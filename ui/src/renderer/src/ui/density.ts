/**
 * Display density — the first Settings › Preferences entry, and a renderer-only, this-Mac choice
 * (localStorage, like the sidebar width), never an account setting: it describes this screen, not this
 * vault.
 *
 * It works by ONE lever — a `data-density` attribute on `<html>` under which app.css re-declares the
 * spacing scale and control sizes. Every rule in the app already spends `--space-*` / `--control-*`, so
 * the whole shell tightens together and no component grows a density prop (PILLAR3: one SSOT for the
 * scale, not a compact variant per component).
 *
 * {@link applyDensity} runs at startup from `main.tsx` — before React's first paint, so the app never
 * renders comfortable and then snaps compact.
 */
import { useCallback, useState } from "react";

/**
 * The densities we ship, in the order the control offers them — the SSOT for BOTH the type and the
 * Preferences control. Adding a rung is one edit here: `Density` follows it, the stored-value guard
 * accepts it, and the segmented control renders it. Named for what each buys you rather than for a
 * number: comfortable buys breathing room, compact buys rows on screen.
 */
export const DENSITY_OPTIONS = [
  { id: "comfortable", label: "Comfortable", icon: "density_medium" },
  { id: "compact", label: "Compact", icon: "density_small" },
] as const satisfies readonly { id: string; label: string; icon: string }[];

export type Density = (typeof DENSITY_OPTIONS)[number]["id"];

/** The first option is the default — the DS scale as vendored, before any tightening. */
export const DEFAULT_DENSITY: Density = DENSITY_OPTIONS[0].id;

/** localStorage key — `cs-` namespaced, matching the sidebar width. */
const STORAGE_KEY = "cs-density";

const isDensity = (v: string | null): v is Density => DENSITY_OPTIONS.some((o) => o.id === v);

/**
 * A raw stored string → a density we actually ship. Anything else — a first run (null), a value from a
 * build that offered a third rung, a hand-edited key — lands on comfortable rather than writing an
 * unknown value onto `<html>`, where it would silently render as no density at all.
 */
export const normalizeDensity = (raw: string | null): Density => (isDensity(raw) ? raw : DEFAULT_DENSITY);

/** The stored choice, falling back to comfortable for a first run (or a value we no longer ship). */
export const readDensity = (): Density => normalizeDensity(localStorage.getItem(STORAGE_KEY));

/** Put the choice on `<html>`, where the CSS looks for it. */
export const applyDensity = (density: Density): void => {
  document.documentElement.dataset.density = density;
};

/**
 * The density preference as state: the current value plus a setter that persists it and re-paints the
 * app in the same tick. Live in whichever view owns the control — the effect is global by construction
 * (a document attribute), so nothing has to be threaded down from App.
 */
export const useDensity = (): [Density, (density: Density) => void] => {
  const [density, setState] = useState<Density>(readDensity);
  const set = useCallback((next: Density): void => {
    localStorage.setItem(STORAGE_KEY, next);
    applyDensity(next);
    setState(next);
  }, []);
  return [density, set];
};
