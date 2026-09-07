import { fileURLToPath } from "node:url";
import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { visualizer } from "rollup-plugin-visualizer";

const here = path.dirname(fileURLToPath(import.meta.url));

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;
// @ts-expect-error process is a nodejs global
const analyze = !!process.env.ANALYZE;

// NO manualChunks — deliberately (B1d finding, do not re-add). Pinning vendor
// groups makes rollup CO-LOCATE shared dependencies into the pinned chunks
// (measured: react fragments landed in an editor pin, lodash-es/dompurify in
// a mermaid pin, unrelated shared helpers in an xterm pin), which the entry
// then statically imports — boot-path bloat spread across chunks. The honest
// metric instead lives in scripts/check-size.mjs: `bootJsBytes` budgets the
// entry chunk PLUS everything dist/index.html modulepreloads (the entry's
// full transitive static closure), so any statically re-merged vendor family
// (tiptap/prosemirror/yjs ~800 kB, mermaid ~600 kB, codemirror ~350 kB,
// xterm ~390 kB, docx ~350 kB, the highlight.js barrel ~600 kB) trips the
// ~10% ratchet no matter which chunk it lands in.
// src/lib/sizeGuard.test.ts pins the same boundaries at source level.

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [
    react(),
    tailwindcss(),
    // ANALYZE=1 npm run build → build-analysis/stats.html treemap
    // (docs/perf-budget.md). Deliberately OUTSIDE `dist/`: everything under
    // dist is embedded into the binary by Tauri and counted by
    // `distTotalBytes`, so writing the treemap there inflated the very number
    // the treemap exists to explain — and shipped a ~1 MB developer artifact
    // to users on any build that happened to run with ANALYZE set.
    // Two outputs: the treemap to look at, and the raw module graph to
    // MEASURE. Per-module attribution ("what is actually in the boot chunk,
    // rolled up by package") is a query over the JSON — the HTML can only be
    // read by a human, which is how a 670 kB markdown stack sat on the boot
    // path unnoticed.
    ...(analyze
      ? [
          visualizer({ filename: "build-analysis/stats.html", gzipSize: true }),
          visualizer({
            filename: "build-analysis/stats.json",
            template: "raw-data",
          }),
        ]
      : []),
  ],

  build: {
    rollupOptions: {
      // Two entries, ONE build: the app and the async-share viewer
      // (viewer/index.html → dist/viewer/) share every chunk instead of the
      // viewer re-bundling its own copy of the editor/mermaid/katex stack
      // (that standalone dist-viewer bundle duplicated ~2.3 MB and rode the
      // .app as a 4.2 MB resource). The daemon serves the viewer page at
      // /viewer/ and its shared chunks at /assets/* from the embedded app
      // assets — see serve_viewer_* in src-tauri/src/lib.rs.
      input: {
        index: path.resolve(here, "index.html"),
        viewer: path.resolve(here, "viewer/index.html"),
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
