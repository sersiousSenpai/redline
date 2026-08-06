#!/usr/bin/env node
// Size-budget checker (docs/perf-budget.md "Size budget").
//
//   node scripts/check-size.mjs            # report; warn on breach (exit 0)
//   node scripts/check-size.mjs --strict   # CI mode: breach OR missing artifact exits 1
//
// Budgets live in scripts/size-budget.json. Artifacts that haven't been built
// are reported as skipped locally — in --strict mode the build step must have
// produced them, so missing means fail rather than silently passing.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const strict = process.argv.includes("--strict");
const budget = JSON.parse(
  readFileSync(join(root, "scripts", "size-budget.json"), "utf8"),
);

function dirTotal(path) {
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const p = join(path, entry.name);
    if (entry.isDirectory()) total += dirTotal(p);
    else if (entry.isFile()) total += statSync(p).size;
  }
  return total;
}

// The boot-path JS: the entry chunk PLUS every chunk dist/index.html
// modulepreloads (Vite lists the entry's full transitive static-import
// closure there — since the viewer became a second entry, modules shared by
// both entries live in preloaded shared chunks, so the entry file alone
// under-counts). Budgeting the SUM keeps the metric honest: any statically
// re-merged vendor family (tiptap/prosemirror/yjs ~800 kB, mermaid ~600 kB,
// codemirror ~350 kB, xterm ~390 kB, docx ~350 kB, the highlight.js barrel
// ~600 kB) lands somewhere in this closure and trips the ~10% ratchet. See
// also the no-manualChunks comment in vite.config.ts: pins would smuggle
// boot cost into chunks whose weight this sum WOULD still see — but with
// co-located lazy vendors wrongly added in, so the failure mode is loud
// either way.
function bootPathJs() {
  const entry = join(root, "dist", "index.html");
  if (!existsSync(entry)) return null;
  const html = readFileSync(entry, "utf8");
  const scripts = [...html.matchAll(/<script[^>]*\bsrc="\/?([^"]+)"/g)].map(
    (m) => m[1],
  );
  const preloads = [
    ...html.matchAll(/rel="modulepreload"[^>]*href="\/?([^"]+\.js)"/g),
  ].map((m) => m[1]);
  const problems = [];
  if (scripts.length !== 1) {
    problems.push(`expected exactly 1 entry script tag, found ${scripts.length}`);
  }
  let total = 0;
  const parts = [];
  for (const rel of [...scripts, ...preloads]) {
    const file = join(root, "dist", rel);
    if (!existsSync(file)) {
      problems.push(`referenced asset missing on disk: ${rel}`);
      continue;
    }
    const size = statSync(file).size;
    total += size;
    parts.push(`${rel} ${mb(size)}`);
  }
  return { total, parts, problems };
}

const mb = (bytes) => (bytes / 1_000_000).toFixed(2) + " MB";

const binaryPath = join(root, "src-tauri", "target", "release", "redline");
const mcpBinPath = join(root, "src-tauri", "target", "release", "redline-mcp");
const boot = bootPathJs();
const checks = [
  {
    name: "release binary (src-tauri/target/release/redline)",
    actual: existsSync(binaryPath) ? statSync(binaryPath).size : null,
    limit: budget.binaryBytes,
  },
  {
    name: "mcp proxy binary (src-tauri/target/release/redline-mcp)",
    actual: existsSync(mcpBinPath) ? statSync(mcpBinPath).size : null,
    limit: budget.mcpBinBytes,
  },
  {
    name: `boot-path JS (${boot ? boot.parts.join(" + ") : "dist/index.html entry + modulepreloads"})`,
    actual: boot ? boot.total : null,
    limit: budget.bootJsBytes,
  },
  {
    name: "dist total",
    actual: existsSync(join(root, "dist")) ? dirTotal(join(root, "dist")) : null,
    limit: budget.distTotalBytes,
  },
];
// dist-viewer/ has no row anymore: the async-share viewer folded into the
// main build as a second Rollup entry (B1d), so its weight is part of "dist
// total" and the standalone bundle is no longer built or shipped.

let failed = false;
for (const { name, actual, limit } of checks) {
  if (actual === null) {
    console.log(`SKIP  ${name} — not built`);
    if (strict) failed = true;
    continue;
  }
  const ok = actual <= limit;
  const pct = ((actual / limit) * 100).toFixed(1);
  console.log(
    `${ok ? " ok " : "OVER"}  ${name} — ${mb(actual)} of ${mb(limit)} (${pct}%)`,
  );
  if (!ok) failed = true;
}

if (boot && boot.problems.length > 0) {
  console.log(`OVER  boot-path shape: ${boot.problems.join("; ")}`);
  failed = true;
}

if (failed) {
  console.error(
    strict
      ? "\nsize budget exceeded (or artifact missing) — see docs/perf-budget.md 'Size budget'"
      : "\nWARNING: size budget exceeded — see docs/perf-budget.md 'Size budget'",
  );
  if (strict) process.exit(1);
}
