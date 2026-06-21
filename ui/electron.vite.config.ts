import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

/**
 * electron-vite drives all three processes. With the conventional `src/{main,preload,renderer}`
 * layout the entry points are auto-discovered, so config stays minimal.
 *
 * `externalizeDepsPlugin` keeps Node builtins + deps external in main/preload — so the layer-1 client
 * keeps using Electron's bundled `node:net` rather than getting bundled. The renderer is a normal Vite
 * React app (its deps ARE bundled).
 */
export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()] },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: {
    root: "src/renderer",
    plugins: [react()],
  },
});
