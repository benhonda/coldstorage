/**
 * Local settings state — exclude patterns. Renderer-owned for now because the daemon doesn't expose
 * get/set yet (an open contract gap — see ELECTRON-UI-DESIGN.md): gitignore-style globs applied at scan
 * time (global + per-source later). SEAM: when the daemon grows the commands, fetch on connect and
 * persist on change here. (Download destination is no longer a setting — it's chosen per download, in
 * the download dialog.)
 */
import { useCallback, useState } from "react";

/** Smart defaults — the junk a non-technical user never means to upload. Shown as removable chips. */
const DEFAULT_EXCLUDES = ["node_modules", ".DS_Store", "*.tmp", ".git", "caches"];

export interface SettingsApi {
  excludes: string[];
  addExclude: (pattern: string) => void;
  removeExclude: (pattern: string) => void;
}

export const useSettings = (): SettingsApi => {
  const [excludes, setExcludes] = useState<string[]>(DEFAULT_EXCLUDES);

  const addExclude = useCallback((pattern: string): void => {
    const p = pattern.trim();
    if (p) setExcludes((prev) => (prev.includes(p) ? prev : [...prev, p]));
  }, []);

  const removeExclude = useCallback((pattern: string): void => {
    setExcludes((prev) => prev.filter((x) => x !== pattern));
  }, []);

  return { excludes, addExclude, removeExclude };
};
