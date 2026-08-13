// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { invoke, Channel } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { WebglAddon } from "@xterm/addon-webgl";
import { loadXterm, xtermMods, type XtermMods } from "../lib/xtermLoader";
import { contrastRatio, luminance, mix } from "../theme/derive";
import { getTheme, type AnsiSlot } from "../theme/themes";
import { isResizing, onResizeSession } from "../lib/resizeSession";
import type { HandoffDeps } from "../lib/terminalHandoff";
import { enqueuePtyOp, enqueuePtyOpChecked } from "../lib/ptyFence";
import {
  createResizeScheduler,
  isUsableTermSize,
  type ResizeScheduler,
} from "../lib/termSize";

interface TerminalViewProps {
  /** Stable per-tab id; keys the backend PTY and filters its events. */
  id: string;
  /** Workspace cwd the shell starts in (last session's project, else $HOME). */
  cwd: string | null;
  /** Re-themes xterm when the app theme changes. */
  theme: string;
  /** True when this is the active, non-collapsed tab (drives fit/resize). */
  visible: boolean;
  /** Called when a hidden tab produces output (drives the unseen badge). */
  onActivity: (id: string) => void;
  /** Called when this tab's shell exits. */
  onExit: (id: string) => void;
  /** Called when the shell or a TUI rewrites the window title (OSC 0/2) — the
   *  one "what is running in here" signal a terminal volunteers. Fires only on
   *  an actual title sequence, never per output chunk. */
  onTitle?: (id: string, title: string) => void;
  /** Called with this terminal's id when the user clicks into its pane — lets
   *  the host focus the tile that shows it. Carries the id so ONE stable
   *  callback serves every tile in the grid (a per-tile closure would re-mint
   *  N functions per render and defeat the fleet's memo). */
  onPaneFocus?: (id: string) => void;
}

// POSIX single-quote escaping so paths with spaces/quotes paste safely.
function shellQuote(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

// Per-terminal-id ordering fence for spawn/kill. React dev StrictMode mounts
// every TerminalView twice — spawn → kill → spawn under one id — and the three
// invokes race on the backend's command pool. If the respawn overtakes the
// kill, pty_spawn no-ops (id still registered), the kill then destroys the
// only shell, and the surviving mount's output channel was never bound: a
// dead "[process exited]" terminal. Chaining each id's lifecycle ops makes
// the order deterministic: spawn completes, then kill, then respawn.
// Cap on raw bytes stashed for a hidden terminal before the oldest are dropped.
// ~2 MB comfortably covers a full screen + the 5000-line scrollback xterm keeps
// after the drain, so the visible result is identical to never having hidden it
// (minus ancient output a flood would have evicted from scrollback anyway).
const MAX_HIDDEN_BUFFER_BYTES = 2 * 1024 * 1024;

/** A column-changing fit this cheap can run on every frame of a drag — it fits
 *  inside a 120Hz frame with room for the rest of the app. */
const COL_FIT_BUDGET_MS = 6;
/** Over budget, a reflow may occupy at most 1/DUTY of the wall clock, so an
 *  expensive scrollback rate-limits itself instead of starving every frame. */
const COL_FIT_DUTY = 6;
/** …but never slower than this, so even a pathological buffer still visibly
 *  reflows a few times during a drag rather than appearing frozen. */
const COL_FIT_MIN_GAP_MS = 120;

/** Ceiling on simultaneously live WebGL renderers. WebKit caps live WebGL
 *  contexts per process (~16), and at the cap it loses the OLDEST context
 *  rather than refusing the new one — so an unbounded "one context per mounted
 *  terminal" degrades the longest-lived terminals silently, exactly as a long
 *  session starts tiling many at once. Contexts are therefore tied to
 *  *visibility* (created on show, disposed on hide), which bounds them to the
 *  tile count, and this ceiling backstops even that: a terminal past it keeps
 *  xterm's DOM renderer — a deliberate fallback instead of a context loss that
 *  never comes back. */
const MAX_WEBGL = 8;
let liveWebglContexts = 0;

// The fence lives in src/lib/ptyFence.ts (pure, unit-tested); re-exported
// here so existing importers keep their path.
export { enqueuePtyOp };

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
function spawnDeferred(id: string): SpawnDeferred {
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
function tapPtyOutput(id: string, bytes: Uint8Array) {
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
  // The write rides the SAME per-id fence as spawn/kill/resize. Without it,
  // dev StrictMode's double-mount queues [spawn₁, kill₁, spawn₂] and the
  // handoff's write — released by spawn₁'s signal — races kill₁: when it wins
  // the backend truthfully reports delivery into the doomed first shell, and
  // the user watches the second come up empty (the lost-restore bug). Fenced,
  // the write serializes behind the churn and lands in the surviving shell;
  // rejection ("terminal not running") still reaches the handoff.
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

// xterm.js's built-in defaults (the Tango palette), spelled out so the dark
// branch goes through the same override-merge + contrast clamp as the light
// branch — previously dark themes got these implicitly, which left Ocean's
// blue page with an invisible #555753 dim grey.
const DARK_ANSI: Record<AnsiSlot, string> = {
  black: "#2e3436",
  red: "#cc0000",
  green: "#4e9a06",
  yellow: "#c4a000",
  blue: "#3465a4",
  magenta: "#75507b",
  cyan: "#06989a",
  white: "#d3d7cf",
  brightBlack: "#555753",
  brightRed: "#ef2929",
  brightGreen: "#8ae234",
  brightYellow: "#fce94f",
  brightBlue: "#729fcf",
  brightMagenta: "#ad7fa8",
  brightCyan: "#34e2e2",
  brightWhite: "#eeeeec",
};

/** Per-slot contrast floor against the terminal background. `brightBlack`
 *  renders Claude Code's dim/secondary text, so it gets the body-text floor;
 *  `black` is conventionally a background/fill slot and is never clamped. */
function slotFloor(slot: AnsiSlot): number {
  return slot === "brightBlack" ? 4.5 : 3.0;
}

/** Raise `color` toward `fg` just enough to clear `floor` contrast vs `bg`.
 *  Same monotonic binary search as derive.ts's mutedInk, inverted. */
function clampSlot(color: string, bg: string, fg: string, floor: number): string {
  if (contrastRatio(color, bg) >= floor) return color;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (contrastRatio(mix(color, fg, mid), bg) >= floor) hi = mid;
    else lo = mid;
  }
  return mix(color, fg, hi);
}

function readXtermTheme(themeName: string) {
  const s = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) =>
    s.getPropertyValue(name).trim() || fallback;
  const bg = v("--color-paper", "#fafaf7");
  const fg = v("--color-ink", "#1a1a1a");
  const base = {
    background: bg,
    foreground: fg,
    cursor: fg,
    cursorAccent: bg,
    selectionBackground: v("--color-rule", "#e5e3dd"),
  };
  let palette: Record<AnsiSlot, string>;
  if (luminance(bg) < 0.5) {
    palette = { ...DARK_ANSI };
  } else {
    // Light themes (e.g. Novel, Silver Aerogel): xterm's dark-bg ANSI defaults
    // (bright yellow/white/cyan) wash out against the pale paper. Map the
    // palette to darker, saturated hues — reusing the theme's own accent
    // tokens for the blue/green/yellow slots so the terminal stays on-brand.
    const info = v("--color-info", "#3b5bb5");
    const warning = v("--color-warning", "#9c6f1b");
    const success = v("--color-success", "#2f7d32");
    palette = {
      black: "#3b3b3b",
      red: "#b3261e",
      green: success,
      yellow: warning,
      blue: info,
      magenta: "#8a2a8a",
      cyan: "#0e6b7a",
      white: "#5c5c5c",
      brightBlack: "#6b6b6b",
      brightRed: "#c5341d",
      brightGreen: success,
      brightYellow: warning,
      brightBlue: info,
      brightMagenta: "#a23299",
      brightCyan: "#1597a8",
      brightWhite: fg,
    };
  }
  // Hand-tuned per-theme overrides win over the branch defaults…
  Object.assign(palette, getTheme(themeName).ansi);
  // …and a contrast clamp backstops every text slot, so a mid-luminance
  // background (Silver Aerogel's grey, Ocean's blue) can never render
  // invisible dim text no matter which branch it landed in.
  for (const slot of Object.keys(palette) as AnsiSlot[]) {
    if (slot === "black") continue;
    palette[slot] = clampSlot(palette[slot], bg, fg, slotFloor(slot));
  }
  return { ...base, ...palette };
}

// One xterm instance bound to one backend PTY (keyed by `id`). Many of these
// stay mounted at once (one per tab) so shells + scrollback persist while
// hidden; only the active, non-collapsed view is `visible` and drives fit().
// Memoized so an App/TerminalTabs re-render that doesn't change this tab's props
// (a comment focus flip, a divider drag commit, a sibling tab's activity) skips
// reconciling all 8 mounted terminals. The heavy lifting lives in effects keyed
// on `id`; memo just spares the needless render pass across the fleet.
export const TerminalView = memo(function TerminalView({
  id,
  cwd,
  theme,
  visible,
  onActivity,
  onExit,
  onTitle,
  onPaneFocus,
}: TerminalViewProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  // Debounced, deduped PTY-resize path shared by every fit site. The send is
  // chained per id through enqueuePtyOp so an in-flight resize (or the spawn
  // itself) is never overlapped by the next one.
  const schedulerRef = useRef<ResizeScheduler | null>(null);
  if (schedulerRef.current === null) {
    schedulerRef.current = createResizeScheduler((size) => {
      void enqueuePtyOp(id, () =>
        invoke("pty_resize", { id, cols: size.cols, rows: size.rows }).catch(
          () => {},
        ),
      );
    });
  }

  // What a column-changing fit cost this terminal last time, and when. See
  // `applyFit` — the reflow's cost is a property of THIS terminal's scrollback,
  // so it is measured rather than guessed.
  const colFitCostRef = useRef(0);
  const colFitAtRef = useRef(0);

  // The one way any code here fits the terminal: verify the proposed geometry
  // is usable first (a squished host proposes FitAddon's 2×1 floor, which
  // corrupts claude's TUI if it ever reaches the PTY), then fit and hand the
  // resulting size to the scheduler. `immediate` marks single-shot callers
  // (tab shown, window focus); drag-driven callers debounce to a settle.
  //
  // `live` marks a caller running inside a drag, where the frame budget is the
  // whole point:
  //
  //   ROWS are free. xterm reflows only when the COLUMN count changes; a row
  //   change just moves the viewport over the buffer, and xterm backfills new
  //   rows from scrollback so the prompt stays exactly where it is. That is
  //   precisely how a native terminal behaves when you drag its edge, so rows
  //   always track the pointer.
  //
  //   COLUMNS rewrap every line of scrollback. A young buffer does that in well
  //   under a frame and can stay just as live; a 5000-line one cannot. So the
  //   last reflow is timed, and while it is over budget further ones are rate
  //   limited to what this terminal can actually sustain — the text keeps
  //   reflowing as you drag, just not every frame, and the settle fit at the
  //   end of the drag always lands the exact final size.
  const applyFit = useCallback(
    (opts: { immediate: boolean; live?: boolean }) => {
      const term = termRef.current;
      const fit = fitRef.current;
      if (!term || !fit) return;
      let dims: { cols: number; rows: number } | undefined;
      try {
        dims = fit.proposeDimensions();
      } catch {
        return; /* host detached */
      }
      if (!isUsableTermSize(dims)) return;
      const colsChanged = dims.cols !== term.cols;
      // We already know the proposal — if it matches, skipping the call also
      // skips FitAddon's own redundant second `proposeDimensions()` (two more
      // `getComputedStyle` reads).
      if (colsChanged || dims.rows !== term.rows) {
        if (opts.live && colsChanged && colFitCostRef.current > COL_FIT_BUDGET_MS) {
          const gap = Math.max(
            COL_FIT_MIN_GAP_MS,
            colFitCostRef.current * COL_FIT_DUTY,
          );
          if (performance.now() - colFitAtRef.current < gap) return;
        }
        const started = colsChanged ? performance.now() : 0;
        try {
          fit.fit();
        } catch {
          return; /* host detached mid-fit */
        }
        if (colsChanged) {
          colFitCostRef.current = performance.now() - started;
          colFitAtRef.current = performance.now();
        }
      }
      schedulerRef.current?.schedule(
        { cols: term.cols, rows: term.rows },
        opts.immediate,
      );
    },
    [],
  );

  // The mount effect runs once ([]-deps, "spawn once"), so anything it closes
  // over goes stale. Mirror the live values into refs it can read each tick.
  const visibleRef = useRef(visible);
  const onActivityRef = useRef(onActivity);
  const onExitRef = useRef(onExit);
  const onTitleRef = useRef(onTitle);
  visibleRef.current = visible;
  onActivityRef.current = onActivity;
  onExitRef.current = onExit;
  onTitleRef.current = onTitle;

  // Raw PTY bytes that arrived while this tab was hidden. We skip xterm's ANSI
  // parse for off-screen terminals (the dominant background cost with a fleet
  // of tabs) and stash the bytes here, draining them in a single write the
  // moment the tab is shown. Bounded so a flooding background shell can't grow
  // it without limit — oldest bytes drop, mirroring xterm's own scrollback
  // eviction. With 8 tabs and one running `yes`, the 7 hidden terminals do zero
  // parse work until looked at.
  const pendingRef = useRef<{ chunks: Uint8Array[]; size: number }>({
    chunks: [],
    size: 0,
  });
  const drainPending = useCallback(() => {
    const term = termRef.current;
    const p = pendingRef.current;
    if (!term || p.chunks.length === 0) return;
    const merged = new Uint8Array(p.size);
    let off = 0;
    for (const c of p.chunks) {
      merged.set(c, off);
      off += c.length;
    }
    p.chunks = [];
    p.size = 0;
    term.write(merged);
  }, []);

  // The xterm module set loads once, at the first terminal's mount, and is
  // cached for the app's lifetime (lib/xtermLoader) — every later mount sees
  // it synchronously and behaves exactly as a static import did. `xt` flips
  // null → mods at most once per component, so the create effect below still
  // runs its body exactly once per tab.
  const [xt, setXt] = useState<XtermMods | null>(xtermMods());
  useEffect(() => {
    if (xt) return;
    let gone = false;
    loadXterm().then(
      (m) => {
        if (!gone) setXt(m);
      },
      (err) => console.error("[redline] xterm failed to load:", err),
    );
    return () => {
      gone = true;
    };
  }, [xt]);

  // Create the terminal + PTY once.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !xt) return;
    const { Terminal, FitAddon } = xt;

    const term = new Terminal({
      fontFamily:
        getComputedStyle(document.documentElement)
          .getPropertyValue("--font-mono")
          .trim() || "ui-monospace, Menlo, monospace",
      fontSize: 13,
      cursorBlink: true,
      theme: readXtermTheme(theme),
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    // OSC 0/2. Disposed with the terminal below, along with every other addon
    // and listener it owns.
    term.onTitleChange((title) => onTitleRef.current?.(id, title));

    // Per-terminal raw-byte output stream. One Channel = one subscriber (this
    // tab) → no N-tab event fan-out, no id filtering, no base64. Bytes arrive
    // as an ArrayBuffer; write them straight to xterm. The write callback is our
    // flow-control ACK — it fires once xterm has parsed the chunk, so we report
    // the byte count back and the backend only keeps reading while we keep up.
    const onOutput = new Channel<ArrayBuffer>();
    onOutput.onmessage = (buf) => {
      const bytes = new Uint8Array(buf);
      // Observation tap first (no-op unless someone awaits this tab's
      // output), so hidden tabs are observable too.
      tapPtyOutput(id, bytes);
      // Hidden tab: stash the raw bytes (bounded) and ack immediately so the
      // backend keeps flowing — but pay no parse cost until the tab is shown.
      if (!visibleRef.current) {
        const p = pendingRef.current;
        p.chunks.push(bytes);
        p.size += bytes.length;
        while (p.size > MAX_HIDDEN_BUFFER_BYTES && p.chunks.length > 1) {
          p.size -= p.chunks.shift()!.length;
        }
        void invoke("pty_ack", { id, n: bytes.length }).catch(() => {});
        onActivityRef.current(id);
        return;
      }
      // Visible: drain anything buffered while hidden first so byte order is
      // preserved, then write this chunk (its ack gates the backend as before).
      drainPending();
      term.write(bytes, () => {
        void invoke("pty_ack", { id, n: bytes.length }).catch(() => {});
      });
    };

    // A hidden (display:none / zero-height) host makes fit() compute 0×0; a
    // 0-row PTY corrupts output. Fall back to a sane size when spawning while
    // not yet visible — the [visible] effect re-fits once shown.
    void enqueuePtyOp(id, () =>
      invoke("pty_spawn", {
        id,
        cwd,
        cols: term.cols || 80,
        rows: term.rows || 24,
        onOutput,
      }).then(
        () => spawnDeferred(id).resolve(),
        (e) => {
          spawnDeferred(id).reject(e);
          // Skip the writeln if this mount was already torn down (StrictMode).
          if (termRef.current === term) {
            term.writeln(`\r\n[redline: failed to start shell: ${e}]`);
          }
        },
      ),
    );

    const dataSub = term.onData((d) => {
      void invoke("pty_write", { id, data: d }).catch(() => {});
    });

    const exitPromise = listen<{ id: string }>("pty-exit", (e) => {
      if (e.payload.id !== id) return;
      term.writeln("\r\n[process exited]");
      onExitRef.current(id);
    });

    // Tauri intercepts OS file drops at the webview level (dragDropEnabled
    // defaults true), so HTML5 drop events never reach xterm. Listen for
    // Tauri's own event instead — it carries real absolute paths — and
    // type the quoted path(s) at the prompt (no Enter, so they're editable).
    const dropPromise = getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type !== "drop") return;
      if (!visibleRef.current) return;
      const paths = event.payload.paths;
      if (!paths || paths.length === 0) return;

      // Only act when the drop lands over the terminal host element. wry
      // reports the position in logical AppKit points (relabeled "physical"
      // without scaling by Tauri), and the webview's top-left is the CSS
      // viewport origin — so compare to getBoundingClientRect() directly. Do
      // NOT divide by devicePixelRatio: on Retina that halves the point and
      // rejects any terminal not pinned to the top-left.
      const h = hostRef.current;
      if (h) {
        const r = h.getBoundingClientRect();
        const x = event.payload.position.x;
        const y = event.payload.position.y;
        if (x < r.left || x > r.right || y < r.top || y > r.bottom) return;
      }

      const text = paths.map(shellQuote).join(" ") + " ";
      void invoke("pty_write", { id, data: text }).catch(() => {});
      termRef.current?.focus();
    });

    // Defensive guard: if a drag or paste ever slips past Tauri's native
    // handler (e.g. a drag carrying no file URL, or an image on the clipboard),
    // WebKit's default behavior inserts a synthetic "[image 1]" into xterm's
    // hidden textarea. Swallow those DOM events so no fake image content ever
    // reaches the terminal. When the native handler consumes a drop (the normal
    // path) these never fire and the guard is inert.
    const swallowDrag = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
    };
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (items && Array.from(items).some((it) => it.kind === "file")) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    host.addEventListener("dragover", swallowDrag);
    host.addEventListener("drop", swallowDrag);
    host.addEventListener("paste", onPaste, true);

    const ro = new ResizeObserver(() => {
      // A hidden view has no usable geometry; the [visible] effect re-fits
      // when shown. Divider drags fire this once per frame — rows apply now,
      // a column change waits for the drag to end (see applyFit). The PTY
      // resize is debounced either way, so the shell is told once, at rest.
      if (!visibleRef.current) return;
      applyFit({ immediate: false, live: isResizing() });
    });
    ro.observe(host);

    // After the OS app returns from the background, a still-`visible` terminal
    // gets no `visible` transition to re-fit/re-focus it — and a webview that
    // was backgrounded can leave the xterm renderer stale and the pane
    // unfocused. Re-fit, repaint and refocus on every window-focus regain so
    // the terminal never strands the user.
    // Refocus only when the terminal actually held the caret at blur — the
    // regain must not yank typing away from wherever the user really was.
    // Two gates: activeElement-in-host at blur (user was in another DOM
    // surface, e.g. an editor), and document.hasFocus() at regain (macOS
    // restored first-responder to the browser child webview, so the main
    // webview never got key back — focusing now would steal it).
    let heldFocusAtBlur = false;
    const focusPromise = getCurrentWindow().onFocusChanged(
      ({ payload: focused }) => {
        if (!focused) {
          heldFocusAtBlur = host.contains(document.activeElement);
          return;
        }
        if (!visibleRef.current) return;
        requestAnimationFrame(() => {
          const term = termRef.current;
          if (!term) return;
          applyFit({ immediate: true });
          if (term.cols > 0 && term.rows > 0) {
            term.refresh(0, term.rows - 1);
          }
          if (heldFocusAtBlur && document.hasFocus()) term.focus();
        });
      },
    );

    return () => {
      ro.disconnect();
      schedulerRef.current?.cancel();
      dataSub.dispose();
      host.removeEventListener("dragover", swallowDrag);
      host.removeEventListener("drop", swallowDrag);
      host.removeEventListener("paste", onPaste, true);
      void exitPromise.then((un) => un());
      void dropPromise.then((un) => un());
      void focusPromise.then((un) => un());
      void enqueuePtyOp(id, () => invoke("pty_kill", { id }));
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // Spawn once for this tab's lifetime; cwd/theme/visibility are applied via
    // the effects below (and refs) without re-forking the shell. `xt` changes
    // at most once (null → loaded), and the body doesn't run until it has.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [xt]);

  // GPU renderer: offloads cell rendering to WebGL so a fast stream doesn't
  // peg the main thread compositing the DOM. Scoped to VISIBILITY, not mount —
  // a hidden terminal paints nothing, and holding a context for it is what
  // walks the app into WebKit's process-wide cap (see MAX_WEBGL). The show
  // transition already pays for a full repaint (the [visible] effect's
  // `term.refresh`), so the renderer swap costs nothing extra. WebGL can also
  // fail to init or lose its context at runtime — every path falls back to
  // xterm's default renderer rather than breaking the terminal, and the next
  // show transition tries again.
  useEffect(() => {
    if (!visible || !xt) return;
    const term = termRef.current;
    if (!term) return;
    if (liveWebglContexts >= MAX_WEBGL) return;
    let addon: WebglAddon;
    try {
      addon = new xt.WebglAddon();
    } catch {
      return; /* no WebGL here — xterm's default renderer stays active */
    }
    liveWebglContexts++;
    // Shared by context loss and the hide/unmount cleanup, which can both fire
    // for one addon — the counter must move exactly once either way.
    let dropped = false;
    const drop = () => {
      if (dropped) return;
      dropped = true;
      liveWebglContexts--;
      try {
        addon.dispose();
      } catch {
        /* already torn down with the terminal */
      }
    };
    addon.onContextLoss(drop);
    try {
      term.loadAddon(addon);
    } catch {
      drop();
      return;
    }
    return drop;
  }, [visible, xt]);

  // Re-theme in place when the app theme changes.
  useEffect(() => {
    const term = termRef.current;
    if (term) term.options.theme = readXtermTheme(theme);
  }, [theme]);

  // Settle at the end of every resize. Rows have been tracking the drag all
  // along; this is where a deferred COLUMN change finally reflows — once, at
  // rest, instead of once per frame.
  useEffect(() => {
    let raf = 0;
    const off = onResizeSession((active) => {
      if (active) return;
      // Next frame, so the release's React commit and the browser's layout
      // have both landed and we fit against the real resting size.
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (!visibleRef.current) return;
        applyFit({ immediate: true });
      });
    });
    return () => {
      off();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [applyFit]);

  // Becoming visible: the host had no usable geometry while hidden, so re-fit
  // on the next frame and tell the PTY its real size.
  useEffect(() => {
    if (!visible) return;
    const raf = requestAnimationFrame(() => {
      const term = termRef.current;
      // Flush whatever streamed in while hidden, in one write, before re-fitting
      // and repainting — so the tab shows fully caught up the instant it opens.
      drainPending();
      applyFit({ immediate: true });
      if (term && term.cols > 0 && term.rows > 0) {
        // Force a renderer repaint — a pane that was hidden (display:none)
        // can come back with a stale xterm render surface.
        term.refresh(0, term.rows - 1);
      }
      // Explicit user opens (caret, footer, ⇧↓, tab switch) focus the
      // terminal; programmatic reveals arm the suppress window and don't.
      if (performance.now() >= suppressRevealFocusUntil) term?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [visible, id, drainPending, applyFit]);

  return (
    <div
      className="h-full w-full overflow-hidden"
      // Guaranteed click-to-focus: a click anywhere in the pane re-acquires
      // xterm focus even if xterm's own mousedown handling is in a bad state
      // after a background/visibility cycle.
      onPointerDown={() => {
        onPaneFocus?.(id);
        termRef.current?.focus();
      }}
      style={{
        background: "var(--color-paper)",
        padding: "6px 8px",
        display: visible ? "block" : "none",
      }}
    >
      <div ref={hostRef} className="h-full w-full" />
    </div>
  );
});
