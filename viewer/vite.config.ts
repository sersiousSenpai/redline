// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
/**
 * Standalone browser-viewer build (Review Request async mode). Reuses the
 * app's TipTap schema/parser so round-trips are lossless, but bundles NO
 * Tauri — it's a static site you can host on any web server (or open from
 * a local static server). Build: `npm run build:viewer` → `dist-viewer/`.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: here,
  // Relative asset paths so the build works from any mount point.
  base: "./",
  plugins: [react()],
  build: {
    outDir: path.resolve(here, "../dist-viewer"),
    emptyOutDir: true,
  },
});
