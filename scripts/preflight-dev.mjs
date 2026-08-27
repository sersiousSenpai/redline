// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// Dev-boot preflight (`npm predev`, so it runs before vite for both
// `npm run dev` and `npm run tauri dev`).
//
// The failure it exists for: Redline's window dies (webview crash, close)
// while the process survives BY DESIGN — the daemon keeps held reviews and
// PTY children alive. That leftover still owns vite's :1420 and the
// daemon's :7676, so the next `npm run tauri dev` used to die with a bare
// "Port 1420 is already in use" (2026-08-20 incident). This script turns
// that dead end into either a clean handover or a clear sentence:
//
//   - ports free                        → boot on (silent, fast path)
//   - headless Redline on :7676         → authenticated graceful retirement
//     (POST /v1/admin/shutdown with the 0600 daemon.token file), wait for
//     the ports, boot on
//   - Redline WITH a window on :7676    → refuse: use (or quit) that
//     instance — a second dev stack against a live one is never right
//   - orphan vite from this repo on :1420 → terminate it, boot on
//   - anything else on :1420            → refuse, naming pid + command
//
// Node built-ins only. Exit 0 lets vite start; exit 1 aborts the boot with
// the reason printed above vite's own error.

import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const VITE_PORT = 1420;
const DAEMON_PORT = 7676;
const DAEMON = `http://127.0.0.1:${DAEMON_PORT}`;
const RETIRE_WAIT_MS = 12_000; // exit path snapshots the ledger + kills children

const log = (msg) => console.log(`[redline preflight] ${msg}`);
const die = (msg) => {
  console.error(`[redline preflight] ${msg}`);
  process.exit(1);
};

/** The Tauri app-data dir, derived from tauri.conf.json's identifier so the
 *  script can't drift from where the app actually writes daemon.token. */
function appDataDir() {
  const conf = JSON.parse(
    fs.readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
  );
  const id = conf.identifier;
  if (!id) die("src-tauri/tauri.conf.json has no identifier");
  switch (process.platform) {
    case "darwin":
      return path.join(os.homedir(), "Library", "Application Support", id);
    case "win32":
      return path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), id);
    default:
      return path.join(
        process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"),
        id,
      );
  }
}

function connects(host, port) {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host, port });
    const done = (val) => {
      sock.destroy();
      resolve(val);
    };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    sock.setTimeout(1000, () => done(true)); // hung connect: treat as in-use
  });
}

/** True when something is listening on port on EITHER loopback family —
 *  vite binds `[::1]` (localhost resolves IPv6-first on macOS) while the
 *  Rust daemon binds `127.0.0.1`, and a probe that checks only one missed
 *  the other in testing. */
async function portInUse(port) {
  const [v4, v6] = await Promise.all([connects("127.0.0.1", port), connects("::1", port)]);
  return v4 || v6;
}

/** The daemon's identity card, or null when :7676 isn't a Redline. */
async function liveness() {
  try {
    const res = await fetch(`${DAEMON}/v1/liveness`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return null;
    const body = await res.json();
    return body?.app === "redline" ? body : null;
  } catch {
    return null;
  }
}

async function waitForPortsFree(deadlineMs) {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    if (!(await portInUse(VITE_PORT)) && !(await portInUse(DAEMON_PORT))) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/** Gracefully retire a headless incumbent via its own control plane. */
async function retireHeadless(live) {
  const tokenPath = path.join(appDataDir(), "daemon.token");
  let token;
  try {
    token = fs.readFileSync(tokenPath, "utf8").trim();
  } catch {
    die(
      `a headless Redline (pid ${live.pid}) holds the ports but ${tokenPath} is unreadable — ` +
        `retire it manually: kill ${live.pid}`,
    );
  }
  log(`retiring headless Redline (pid ${live.pid}, window closed but process alive)…`);
  let res;
  try {
    res = await fetch(`${DAEMON}/v1/admin/shutdown`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3000),
    });
  } catch (e) {
    die(`shutdown request to the headless Redline failed (${e?.message ?? e}) — kill ${live.pid} manually`);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    die(
      `headless Redline refused shutdown (HTTP ${res.status} ${detail.slice(0, 200)}) — ` +
        `stale token? kill ${live.pid} manually`,
    );
  }
  if (!(await waitForPortsFree(RETIRE_WAIT_MS))) {
    die(`retired Redline (pid ${live.pid}) but the ports did not free in ${RETIRE_WAIT_MS / 1000}s — check the process`);
  }
  log("headless instance retired; ports are free");
}

/** Whoever still listens on :1420 with no Redline daemon in the picture:
 *  an orphan vite from THIS repo is cleared; anything else is named. */
function clearForeignViteHolder() {
  if (process.platform === "win32") {
    die(`port ${VITE_PORT} is in use and no Redline daemon answered — free it manually`);
  }
  let pids = [];
  try {
    pids = execFileSync("lsof", ["-nP", `-tiTCP:${VITE_PORT}`, "-sTCP:LISTEN"], {
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .filter(Boolean);
  } catch {
    // lsof exits 1 when nothing matches — the port freed itself meanwhile.
    return;
  }
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  for (const pid of pids) {
    let command = "";
    let cwd = "";
    try {
      command = execFileSync("ps", ["-o", "command=", "-p", pid], { encoding: "utf8" }).trim();
      // The command line can name vite relatively (`node ./node_modules/.bin/vite`),
      // so identity comes from the process's working directory instead.
      cwd = execFileSync("lsof", ["-a", "-p", pid, "-d", "cwd", "-Fn"], { encoding: "utf8" })
        .split("\n")
        .find((l) => l.startsWith("n"))
        ?.slice(1) ?? "";
    } catch {
      continue; // already gone
    }
    const oursVite = command.includes("vite") && cwd === repoRoot;
    if (!oursVite) {
      die(`port ${VITE_PORT} is held by pid ${pid} (${command.slice(0, 120)}, cwd ${cwd || "?"}) — not ours to kill, free it manually`);
    }
    log(`terminating orphan vite (pid ${pid})…`);
    try {
      process.kill(Number(pid), "SIGTERM");
    } catch {
      continue;
    }
  }
}

const daemonBusy = await portInUse(DAEMON_PORT);
const viteBusy = await portInUse(VITE_PORT);
if (!daemonBusy && !viteBusy) process.exit(0); // the common case: silent

if (daemonBusy) {
  const live = await liveness();
  if (live?.hasWindow) {
    die(
      `Redline is already running with a window (pid ${live.pid}) — ` +
        `use that instance (or quit it) instead of booting a second dev stack`,
    );
  }
  if (live) {
    await retireHeadless(live);
  } else {
    log(`port ${DAEMON_PORT} is held by something that isn't Redline — the app's own readiness preflight will report it`);
  }
}

if (await portInUse(VITE_PORT)) {
  clearForeignViteHolder();
  const until = Date.now() + 3000;
  while (Date.now() < until && (await portInUse(VITE_PORT))) {
    await new Promise((r) => setTimeout(r, 200));
  }
  if (await portInUse(VITE_PORT)) {
    die(`port ${VITE_PORT} is still in use after cleanup — free it manually`);
  }
  log("port cleared; booting");
}
