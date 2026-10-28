// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The full-App QA fixture (fixtures/app-qa: the real App over fake Tauri
//! services) served live, with hot reload, for using the workbench by hand
//! in an ordinary browser rather than capturing scenes:
//!
//!   node scripts/app-serve.mjs [port]
//!   open "http://127.0.0.1:5199/fixtures/app-qa/?board=workbench&clock=live&motion=on"
//!
//! The query parameters are the fixture's own (fixtures/app-qa/main.tsx):
//! `board` (a scenario id or scene name), `theme`, `motion`, `clock`.

import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = "fixtures/app-qa";
const port = Number(process.argv[2] ?? 5199);

const server = await createServer({
  configFile: false,
  root,
  cacheDir: path.join(root, "node_modules/.cache/app-serve"),
  logLevel: "warn",
  optimizeDeps: { entries: [`${fixture}/index.html`] },
  plugins: [react(), tailwindcss()],
  // Every `@tauri-apps/*` specifier, plugins included, is the fake.
  resolve: { alias: [{ find: /^@tauri-apps\/.*$/, replacement: path.join(root, fixture, "services.ts") }] },
  server: { host: "127.0.0.1", port, strictPort: true },
  clearScreen: false,
});
await server.listen();
console.log(`ready http://127.0.0.1:${port}/${fixture}/`);
