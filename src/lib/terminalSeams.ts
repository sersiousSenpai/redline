// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { invoke } from "@tauri-apps/api/core";
import type { HandoffDeps } from "./terminalHandoff";
import { enqueuePtyOpChecked } from "./ptyFence";
import { isEditableTarget } from "./landing";

// What the rest of the app reaches of a terminal without mounting one: the
// verified-handoff seams a launch types through, and the rule for when a
// reveal may take the caret. Outside TerminalView so the boot path carries
// these and not the view, which rides the terminal dock's lazy chunk. The
// first-gesture listeners below must be armed at boot, which is the other
// reason they cannot wait for that chunk.

// --- spawn signal + output tap (the verified-handoff seams) -----------------
//
// `openSessionTerminal` returns before React commits the tab, let alone before
// `pty_spawn` forks a shell — so a caller that wants to type into a fresh
// terminal used to guess with a bare setTimeout, and a write that raced the
// spawn vanished without a trace. These two exports replace the guess: a real
// spawn promise, and an observation tap over the shell's output. Entries are
// keyed by tab id and tiny (a promise + an 8 KB tail); terminals per app
// session number in the dozens, so they are kept for the id's lifetime rather
// than risking a StrictMode teardown pruning an entry a waiter still holds.

interface SpawnDeferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (e: unknown) => void;
}

const ptySpawned = new Map<string, SpawnDeferred>();

/** The lazily-created deferred for a tab's `pty_spawn` — creatable *before*
 *  the TerminalView for that id exists, so a caller that asks first simply
 *  waits for the mount to catch up. */
export function spawnDeferred(id: string): SpawnDeferred {
  let d = ptySpawned.get(id);
  if (!d) {
    let resolve!: () => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // A rejected spawn must not surface as an unhandled rejection when no
    // caller is awaiting it (most tabs are opened by the user, not a handoff).
    promise.catch(() => {});
    d = { promise, resolve, reject };
    ptySpawned.set(id, d);
  }
  return d;
}

/** Resolves when `pty_spawn` for `id` settles OK; rejects on spawn error or
 *  after `timeoutMs`. The tty line discipline buffers input written from the
 *  moment the PTY exists, so once this resolves a command can go immediately —
 *  the old 900 ms rc-file guess was never the real requirement. */
export function whenPtySpawned(id: string, timeoutMs: number): Promise<void> {
  const d = spawnDeferred(id);
  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(
      () => reject(new Error(`terminal ${id} did not spawn within ${timeoutMs}ms`)),
      timeoutMs,
    );
    d.promise.then(
      () => {
        window.clearTimeout(timer);
        resolve();
      },
      (e) => {
        window.clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/** Rolling output tails, kept only for tabs some caller has ever observed —
 *  decoding every chunk of every terminal would be pure waste. */
const OUTPUT_TAIL_BYTES = 8 * 1024;
interface OutputTap {
  tail: string;
  decoder: TextDecoder;
  waiters: {
    re: RegExp;
    resolve: (matched: boolean) => void;
    timer: number;
  }[];
}
const ptyOutputTaps = new Map<string, OutputTap>();

/** Feed one raw output chunk into the tap for `id`, if anyone is observing.
 *  Called from the onOutput handler for BOTH the visible and hidden paths —
 *  this is a tap, not a change to the ack/flow-control path. */
export function tapPtyOutput(id: string, bytes: Uint8Array) {
  const tap = ptyOutputTaps.get(id);
  if (!tap) return;
  tap.tail = (tap.tail + tap.decoder.decode(bytes, { stream: true })).slice(
    -OUTPUT_TAIL_BYTES,
  );
  if (tap.waiters.length === 0) return;
  tap.waiters = tap.waiters.filter((w) => {
    if (!w.re.test(tap.tail)) return true;
    window.clearTimeout(w.timer);
    w.resolve(true);
    return false;
  });
}

/** The house `HandoffDeps` wiring: the spawn signal + output tap above, the
 *  checked write and liveness commands below. One shared instance so every
 *  "open a terminal and type into it" call site (App, TerminalTabs) runs the
 *  same verified path. The journal is a no-op here — the Orchestrate flow
 *  overlays its own session-scoped journal. */
export const tauriHandoffDeps: HandoffDeps = {
  whenSpawned: whenPtySpawned,
  isLive: (id) => invoke<boolean>("pty_is_live", { id }),
  // Writes share the lifecycle fence so a handoff waits for the surviving
  // mount's attachment during StrictMode churn. Rejection ("terminal not
  // running") still reaches the handoff.
  writeChecked: (id, data) =>
    enqueuePtyOpChecked(id, () => invoke("pty_write_checked", { id, data })),
  awaitOutput: (id, match, timeoutMs) => awaitPtyOutput(id, match, timeoutMs),
  journal: () => {},
  sleep: (ms) => new Promise((res) => window.setTimeout(res, ms)),
};

/** Resolve `true` when `match` appears in the tab's output (tested against a
 *  bounded rolling tail that starts accumulating at first observation),
 *  `false` on timeout — never rejects, so callers can treat a missed marker
 *  as "fall back to a settle" rather than an abort. */
export function awaitPtyOutput(
  id: string,
  match: RegExp,
  timeoutMs: number,
): Promise<boolean> {
  let tap = ptyOutputTaps.get(id);
  if (!tap) {
    tap = { tail: "", decoder: new TextDecoder(), waiters: [] };
    ptyOutputTaps.set(id, tap);
  }
  if (match.test(tap.tail)) return Promise.resolve(true);
  const forTap = tap;
  return new Promise<boolean>((resolve) => {
    const waiter = {
      re: match,
      resolve,
      timer: window.setTimeout(() => {
        forTap.waiters = forTap.waiters.filter((w) => w !== waiter);
        resolve(false);
      }, timeoutMs),
    };
    forTap.waiters.push(waiter);
  });
}

// Programmatic terminal reveals (runDevServer, plan launch/restore) open the
// dock without the user asking to type in it. Every visible pane's reveal
// effect ends in term.focus(), which would yank the caret away — from the
// embedded browser page especially, whose native webview loses first-responder
// to the main webview the moment any DOM element takes focus. Call this right
// before a programmatic reveal; the window covers mount + rAF of every pane.
let suppressRevealFocusUntil = 0;
export function suppressTerminalRevealFocus(ms = 1500) {
  suppressRevealFocusUntil = performance.now() + ms;
}

// Boot hands no terminal the caret: until the user's first press or key, a
// reveal is the app putting itself back together, not someone asking to
// type. Every explicit open (the footer, ⇧↓, a tab) starts with one, ahead of
// the reveal it causes.
let userActed = false;
const acted = () => { userActed = true; };
window.addEventListener("pointerdown", acted, true);
window.addEventListener("keydown", acted, true);
/** A fresh launch again, for tests. */
export function __resetRevealFocus(): void {
  userActed = false;
  suppressRevealFocusUntil = 0;
}

/** Whether a reveal may hand the terminal in `host` the caret. Never at
 *  boot, never inside a programmatic reveal's window, never under a modal
 *  (the open front door sweeps everything behind it inert), and never away
 *  from a text field elsewhere — a composer, an editor, a comment box.
 *  Another terminal's caret is fair game: a tile switch is a gesture at the
 *  terminals. */
export function revealMayFocus(host: Element): boolean {
  if (!userActed || performance.now() < suppressRevealFocusUntil || host.closest("[inert]")) return false;
  const active = document.activeElement;
  return !active || host.contains(active) || !!active.closest(".xterm") || !isEditableTarget(active as HTMLElement);
}
