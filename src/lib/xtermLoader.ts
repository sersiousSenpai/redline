// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
/**
 * Load-once dynamic loader for the xterm stack (docs/perf-budget.md "Size
 * budget"). xterm + its addons (~380 kB rendered) stay off the main chunk;
 * the module set loads the first time any TerminalView mounts and is cached
 * for the app's lifetime. Laziness lives HERE, inside the module graph —
 * TerminalView itself is never lazily remounted (unmounting one kills its
 * PTY), so a loaded terminal constructs synchronously exactly as before.
 */
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { WebglAddon } from "@xterm/addon-webgl";

export interface XtermMods {
  Terminal: typeof Terminal;
  FitAddon: typeof FitAddon;
  WebglAddon: typeof WebglAddon;
}

let cached: XtermMods | null = null;
let inflight: Promise<XtermMods> | null = null;

/** The already-loaded module set, or null before the first load completes. */
export function xtermMods(): XtermMods | null {
  return cached;
}

/** Kick off (or join) the one load. Resets on failure so a remount retries. */
export function loadXterm(): Promise<XtermMods> {
  if (!inflight) {
    inflight = Promise.all([
      import("@xterm/xterm"),
      import("@xterm/addon-fit"),
      import("@xterm/addon-webgl"),
      // Vite turns this into a CSS chunk it injects on load.
      import("@xterm/xterm/css/xterm.css"),
    ]).then(
      ([xterm, fit, webgl]) =>
        (cached = {
          Terminal: xterm.Terminal,
          FitAddon: fit.FitAddon,
          WebglAddon: webgl.WebglAddon,
        }),
      (err) => {
        inflight = null;
        throw err;
      },
    );
  }
  return inflight;
}
