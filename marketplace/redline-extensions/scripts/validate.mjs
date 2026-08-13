#!/usr/bin/env node
// Index CI for the Redline extension marketplace.
//
// Validates every entry of index.json against the schema
// `redline.extension-index/1`, then (unless --no-fetch) downloads each
// artifact and verifies its sha256, exact size, and wasm magic. Any failure
// exits non-zero with a readable reason — a bad PR never merges green.
//
// The three closed vocabularies below are MIRRORS. While this tree is
// staged inside the redline repo, drift tests in
// src-tauri/src/marketplace.rs pin them to their sources of truth:
//   KNOWN_SCOPES / KNOWN_EVENTS ← crates/redline-extension-abi
//   LICENSE_ALLOW               ← src-tauri/deny.toml [licenses].allow
// After extraction, updating them is part of the corresponding ABI/policy
// change, reviewed on both repos.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const KNOWN_SCOPES = [
  "plan.suggest",
  "plan.comment",
  "plan.offer",
  "browser.drive",
  "consult",
  "memory.propose",
  "drafter.suggest",
  "review.annotate",
  "orchestration.report",
  "ui.panel",
  "work.file",
  "work.claim",
];

const KNOWN_EVENTS = [
  "plan.received",
  "review.started",
  "review.annotations_changed",
  "comment.offer",
  "ledger.changed",
  "suggestion.resolved",
];

const LICENSE_ALLOW = [
  "Apache-2.0",
  "Apache-2.0 WITH LLVM-exception",
  "MIT",
  "MITNFA",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "Zlib",
  "Unicode-3.0",
  "Unicode-DFS-2016",
  "CC0-1.0",
  "MPL-2.0",
  "BSL-1.0",
  "OpenSSL",
  "Unlicense",
  "CDLA-Permissive-2.0",
];

const SCHEMA = "redline.extension-index/1";
const ARTIFACT_CAP_BYTES = 5 * 1024 * 1024;
const API_VERSION = 1;

const NAME_RE = /^[a-z0-9_-]{1,32}$/;
const SEMVER_RE = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

const noFetch = process.argv.includes("--no-fetch");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];
const fail = (entry, why) => errors.push(`${entry}: ${why}`);

let index;
try {
  index = JSON.parse(readFileSync(join(root, "index.json"), "utf8"));
} catch (e) {
  console.error(`index.json unreadable: ${e.message}`);
  process.exit(1);
}

if (index.schema !== SCHEMA) {
  console.error(`schema must be "${SCHEMA}" (got ${JSON.stringify(index.schema)})`);
  process.exit(1);
}
if (!Array.isArray(index.extensions)) {
  console.error("extensions must be an array");
  process.exit(1);
}

const seen = new Set();
for (const e of index.extensions) {
  const id = typeof e?.name === "string" ? e.name : "<unnamed>";
  if (typeof e !== "object" || e === null) {
    fail(id, "entry must be an object");
    continue;
  }
  if (!NAME_RE.test(e.name ?? "")) fail(id, "name must match ^[a-z0-9_-]{1,32}$");
  if (seen.has(e.name)) fail(id, "duplicate name");
  seen.add(e.name);
  if (!SEMVER_RE.test(e.version ?? "")) fail(id, "version must be strict major.minor.patch");
  if (!e.publisher) fail(id, "publisher is required");
  if (!/^https:\/\//.test(e.repo ?? "")) fail(id, "repo must be an https URL");
  if (!/^https:\/\//.test(e.artifact?.url ?? "")) fail(id, "artifact.url must be an https URL");
  if (!SHA256_RE.test(e.artifact?.sha256 ?? "")) fail(id, "artifact.sha256 must be 64 lowercase hex chars");
  const size = e.artifact?.size;
  if (!Number.isInteger(size) || size <= 0 || size > ARTIFACT_CAP_BYTES)
    fail(id, `artifact.size must be an integer in (0, ${ARTIFACT_CAP_BYTES}]`);
  if (!Array.isArray(e.scopes) || e.scopes.length === 0) fail(id, "scopes must be a non-empty array");
  for (const s of e.scopes ?? []) if (!KNOWN_SCOPES.includes(s)) fail(id, `unknown scope ${JSON.stringify(s)}`);
  for (const ev of e.events ?? []) if (!KNOWN_EVENTS.includes(ev)) fail(id, `unknown event ${JSON.stringify(ev)}`);
  if (e.api_version !== API_VERSION) fail(id, `api_version must be ${API_VERSION}`);
  if (!LICENSE_ALLOW.includes(e.license)) fail(id, `license ${JSON.stringify(e.license)} not in the permissive allowlist`);
  if (!SEMVER_RE.test(e.min_redline ?? "")) fail(id, "min_redline must be strict major.minor.patch");
  if (e.changelog !== undefined && !/^https:\/\//.test(e.changelog)) fail(id, "changelog must be an https URL when present");
}

if (!noFetch && errors.length === 0) {
  for (const e of index.extensions) {
    try {
      const resp = await fetch(e.artifact.url, { redirect: "follow" });
      if (!resp.ok) {
        fail(e.name, `artifact fetch: HTTP ${resp.status}`);
        continue;
      }
      const bytes = Buffer.from(await resp.arrayBuffer());
      if (bytes.length !== e.artifact.size)
        fail(e.name, `artifact is ${bytes.length} bytes, entry says ${e.artifact.size}`);
      const sha = createHash("sha256").update(bytes).digest("hex");
      if (sha !== e.artifact.sha256) fail(e.name, `artifact sha256 ${sha} != entry ${e.artifact.sha256}`);
      if (!bytes.subarray(0, 4).equals(Buffer.from([0, 0x61, 0x73, 0x6d])))
        fail(e.name, "artifact is not a wasm module (bad magic)");
    } catch (err) {
      fail(e.name, `artifact fetch: ${err.message}`);
    }
  }
}

if (errors.length > 0) {
  for (const line of errors) console.error(`✗ ${line}`);
  process.exit(1);
}
console.log(`✓ index.json valid — ${index.extensions.length} extension(s)${noFetch ? " (metadata only)" : ""}`);
