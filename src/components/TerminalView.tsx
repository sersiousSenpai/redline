// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { invoke, Channel } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { acquireGraphics } from "../lib/graphicsAllocation";
import type { WebglAddon } from "@xterm/addon-webgl";
import { loadXterm, xtermMods, type XtermMods } from "../lib/xtermLoader";
import { readTerminalPrefs, terminalFamily, TERMINAL_PREFS_EVENT, type TerminalPrefs } from "../lib/terminalPrefs";
import { contrastRatio, luminance, mix } from "../theme/derive";
import { getTheme, type AnsiSlot } from "../theme/themes";
import { isResizing, onResizeSession } from "../lib/resizeSession";
import { enqueuePtyOp, enqueuePtyOpChecked } from "../lib/ptyFence";
import { isInterruptInput, terminalInputOrigin } from "../lib/terminalInput";
import { registerFileDropTarget } from "../lib/nativeFileDrop";
import { revealMayFocus, spawnDeferred, tapPtyOutput } from "../lib/terminalSeams";
import {
  createResizeScheduler,
  isUsableTermSize,
  type ResizeScheduler,
} from "../lib/termSize";
import {
  cancelTerminalWork,
  deferTerminalWork,
  terminalSwapSettling,
} from "../lib/terminalSwap";

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
  /** Keystrokes, paste and native file drops make a convenience shell the
   *  user's terminal, so a subsequent launch must preserve it. */
  onUserInput?: (id: string) => void;
  /** The user pressed Esc or Ctrl-C in this terminal. An agent interrupted
   *  that way fires no hook at all, so the host clears its "working" here. */
  onInterrupt?: (id: string) => void;
}

// POSIX single-quote escaping so paths with spaces/quotes paste safely.
function shellQuote(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

// No quoting holds a control character: typed at the prompt, a newline in a
// file name is Enter. A name like that (one another app chose for a file it
// promised) is never typed.
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR = /[\u0000-\u001f\u007f]/;

// Per-id ordering covers spawn/attach/detach/kill. Unmount releases the view,
// preserving the shell for StrictMode, HMR and full webview reloads; only an
// explicit close kills it. A new view always rebinds the output channel.
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

/** WebGL renderers, and why a hidden terminal keeps its own. WebKit caps live
 *  WebGL contexts per process (~16) and at the cap loses the OLDEST context
 *  rather than refusing the new one, so contexts come from the shared
 *  graphics allocator (lib/graphicsAllocation), whose ceiling a terminal past
 *  it answers with xterm's DOM renderer — a deliberate fallback instead of a
 *  context loss that never comes back.
 *
 *  A context is acquired when a terminal is first shown and kept across
 *  hides. Giving it back on every hide (the old rule) cost ~80 ms a tile:
 *  xterm builds a DOM renderer in the WebGL one's place, so hiding seven
 *  tiles of a wall swap cost over half a second (spike W0.3). It is given
 *  back when the terminal goes, on a context loss, or when a SHOWN terminal
 *  finds the allocator full: then the terminal hidden longest yields its
 *  context, after the swap has painted (`hiddenGraphics` below). */
// The shared graphics allocator also reserves the Memory Cosmos context.

// The fence lives in src/lib/ptyFence.ts (pure, unit-tested); re-exported
// here so existing importers keep their path.
export { enqueuePtyOp };

// The caret, on request. A reveal hands a newly shown terminal the caret
// through its [visible] effect, but a jump to a tile that is ALREADY on
// screen (⌘⇧J) has no transition to ride — so each live view registers here.
const termFocusers = new Map<string, () => void>();
export function focusTerminalView(id: string): void {
  termFocusers.get(id)?.();
}

// Hidden terminals still holding a WebGL context, longest hidden first: the
// ones a shown terminal may ask to yield when the allocator is full. Each
// value gives that terminal's context back.
const hiddenGraphics = new Map<string, () => void>();

/** Give back the context of the terminal hidden longest. False when no
 *  hidden terminal holds one. */
function reclaimHiddenGraphics(): boolean {
  const first = hiddenGraphics.entries().next();
  if (first.done) return false;
  const [hiddenId, give] = first.value;
  hiddenGraphics.delete(hiddenId);
  give();
  return true;
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
  onUserInput,
  onInterrupt,
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
  const onUserInputRef = useRef(onUserInput);
  const onInterruptRef = useRef(onInterrupt);
  visibleRef.current = visible;
  onActivityRef.current = onActivity;
  onExitRef.current = onExit;
  onTitleRef.current = onTitle;
  onUserInputRef.current = onUserInput;
  onInterruptRef.current = onInterrupt;

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

  // Create a view and either reattach its surviving shell or spawn one.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !xt) return;
    const { Terminal, FitAddon } = xt;
    let disposed = false;
    const attachmentId = crypto.randomUUID();
    let firstOutput = true;
    let replaying = false;
    // StrictMode keeps refs across its effect remount. The backend replays
    // these bytes into the new xterm, so retaining them would replay twice.
    pendingRef.current = { chunks: [], size: 0 };

    const prefs = readTerminalPrefs();
    const term = new Terminal({
      fontFamily: terminalFamily(prefs),
      fontSize: prefs.size,
      lineHeight: prefs.lineHeight,
      allowProposedApi: true,
      // Only while the window is focused (onFocusChanged below keeps it
      // honest): each blink repaints the cell, and nobody is looking.
      cursorBlink: document.hasFocus(),
      theme: readXtermTheme(theme),
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(new xt.Unicode11Addon());
    term.unicode.activeVersion = "11";
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;
    const inputOrigin = terminalInputOrigin(term, () => onUserInputRef.current?.(id));

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
      if (disposed) return;
      const bytes = new Uint8Array(buf);
      // Backend always sends one initial replay frame (empty for a fresh
      // shell), before live bytes. Parse this bounded frame even when hidden
      // so it never mixes with the deferred live buffer. xterm preserves write
      // callback order, clearing this flag before subsequent live parsing.
      // Replayed DSR/DA queries must not inject historical replies into the
      // still-running process; genuine user input remains enabled throughout.
      if (firstOutput) {
        firstOutput = false;
        if (!bytes.length) return;
        replaying = true;
        term.write(bytes, () => {
          replaying = false;
          if (!disposed) void invoke("pty_ack", { id, attachmentId, n: bytes.length }).catch(() => {});
        });
        return;
      }
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
        void invoke("pty_ack", { id, attachmentId, n: bytes.length }).catch(() => {});
        onActivityRef.current(id);
        return;
      }
      // Visible: drain anything buffered while hidden first so byte order is
      // preserved, then write this chunk (its ack gates the backend as before).
      drainPending();
      term.write(bytes, () => {
        if (!disposed) {
          void invoke("pty_ack", { id, attachmentId, n: bytes.length }).catch(() => {});
        }
      });
    };

    // A hidden (display:none / zero-height) host makes fit() compute 0×0; a
    // 0-row PTY corrupts output. Fall back to a sane size when spawning while
    // not yet visible — the [visible] effect re-fits once shown.
    void enqueuePtyOpChecked(id, async () => {
      if (disposed) return;
      const live = await invoke<boolean>("pty_is_live", { id });
      if (disposed) return;
      if (live) {
        await invoke("pty_attach", { id, onOutput, attachmentId });
      } else {
        await invoke("pty_spawn", {
          id,
          cwd,
          cols: term.cols || 80,
          rows: term.rows || 24,
          onOutput,
          attachmentId,
        });
      }
      if (disposed) return;
      spawnDeferred(id).resolve();
      // The saved shell may have had different geometry than this view.
      // This resize follows attachment, never destroys/restarts the shell.
      if (visibleRef.current) applyFit({ immediate: true });
    }).catch((e) => {
      if (disposed) return;
      spawnDeferred(id).reject(e);
      term.writeln(`\r\n[redline: failed to connect shell: ${e}]`);
    });

    const dataSub = term.onData((d) => {
      const userInput = inputOrigin.takeUserInput();
      if (replaying && !userInput) return;
      if (userInput && isInterruptInput(d)) onInterruptRef.current?.(id);
      void invoke("pty_write", { id, data: d }).catch(() => {});
    });
    const focusThis = () => term.focus();
    termFocusers.set(id, focusThis);
    // onData also includes xterm's automatic replies to terminal queries
    // (including replayed queries). Only actual input gestures claim a
    // placeholder: keys, text paste/IME below, and native file drops.
    const keySub = term.onKey(() => inputOrigin.noteGesture());

    const exitPromise = listen<{ id: string }>("pty-exit", (e) => {
      if (disposed || e.payload.id !== id) return;
      term.writeln("\r\n[process exited]");
      onExitRef.current(id);
    });

    // OS file drops never reach xterm as HTML5 events; the drop router hands
    // us real absolute paths instead. Type them quoted at the prompt (no
    // Enter, so they're editable).
    const unregisterDrop = registerFileDropTarget(host, (dropped) => {
      const paths = dropped.filter((p) => !CONTROL_CHAR.test(p));
      if (!visibleRef.current || paths.length === 0) return;
      const text = paths.map(shellQuote).join(" ") + " ";
      onUserInputRef.current?.(id);
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
        return;
      }
      if (e.clipboardData?.getData("text/plain")) inputOrigin.noteGesture();
    };
    const onInput = () => inputOrigin.noteGesture();
    host.addEventListener("dragover", swallowDrag);
    host.addEventListener("drop", swallowDrag);
    host.addEventListener("paste", onPaste, true);
    host.addEventListener("input", onInput, true);
    host.addEventListener("compositionstart", onInput, true);

    const ro = new ResizeObserver(() => {
      // A hidden view has no usable geometry; the [visible] effect re-fits
      // when shown. Divider drags fire this once per frame — rows apply now,
      // a column change waits for the drag to end (see applyFit). The PTY
      // resize is debounced either way, so the shell is told once, at rest.
      if (!visibleRef.current) return;
      // A wall swap reshapes the grid under every kept tile at once: their
      // column reflows wait for the new wall to paint, one fit each.
      if (terminalSwapSettling()) {
        deferTerminalWork(`fit:${id}`, () => {
          if (visibleRef.current) applyFit({ immediate: true });
        });
        return;
      }
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
        if (termRef.current) termRef.current.options.cursorBlink = focused;
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
      disposed = true;
      if (termFocusers.get(id) === focusThis) termFocusers.delete(id);
      ro.disconnect();
      cancelTerminalWork(`fit:${id}`);
      schedulerRef.current?.cancel();
      dataSub.dispose();
      keySub.dispose();
      inputOrigin.dispose();
      host.removeEventListener("dragover", swallowDrag);
      host.removeEventListener("drop", swallowDrag);
      host.removeEventListener("paste", onPaste, true);
      host.removeEventListener("input", onInput, true);
      host.removeEventListener("compositionstart", onInput, true);
      void exitPromise.then((un) => un());
      unregisterDrop();
      void focusPromise.then((un) => un());
      void enqueuePtyOp(id, () => invoke("pty_detach", { id, attachmentId }));
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // Connect once for this view's lifetime; cwd/theme/visibility are applied via
    // the effects below (and refs) without re-forking the shell. `xt` changes
    // at most once (null → loaded), and the body doesn't run until it has.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [xt]);

  // GPU renderer: offloads cell rendering to WebGL so a fast stream doesn't
  // peg the main thread compositing the DOM. Acquired on the first show and
  // KEPT across hides (see the note on `hiddenGraphics`): a hidden terminal
  // paints nothing, so its context only waits, and keeping it is what spares
  // a wall swap the renderer rebuild per hidden tile. WebGL can fail to init
  // or lose its context at runtime — every path falls back to xterm's
  // default renderer rather than breaking the terminal, and the next show
  // tries again.
  const xtRef = useRef(xt);
  xtRef.current = xt;
  const giveGraphicsRef = useRef<(() => void) | null>(null);
  /** Load a WebGL renderer into this terminal. True when there is nothing
   *  more to do (loaded, already held, or no WebGL here at all); false when
   *  the allocator is full. */
  const loadGraphics = useCallback((): boolean => {
    const term = termRef.current;
    const mods = xtRef.current;
    if (!term || !mods) return true;
    if (giveGraphicsRef.current) return true;
    const releaseGraphics = acquireGraphics("terminal");
    if (!releaseGraphics) return false;
    let addon: WebglAddon;
    try {
      addon = new mods.WebglAddon();
    } catch {
      releaseGraphics();
      return true; /* no WebGL here — xterm's default renderer stays active */
    }
    // Shared by context loss, a reclaim and the terminal going, which can
    // all fire for one addon — the counter must move exactly once.
    let given = false;
    const give = () => {
      if (given) return;
      given = true;
      releaseGraphics();
      if (hiddenGraphics.get(id) === give) hiddenGraphics.delete(id);
      if (giveGraphicsRef.current === give) giveGraphicsRef.current = null;
      try {
        addon.dispose();
      } catch {
        /* already torn down with the terminal */
      }
    };
    addon.onContextLoss(give);
    try {
      term.loadAddon(addon);
    } catch {
      give();
      return true;
    }
    giveGraphicsRef.current = give;
    return true;
  }, [id]);

  // The terminal going (its tab closed, or a StrictMode/HMR remount) is the
  // one planned moment a context is given back.
  useEffect(() => {
    if (!xt) return;
    return () => giveGraphicsRef.current?.();
  }, [xt, id]);

  useEffect(() => {
    if (!xt) return;
    const give = giveGraphicsRef.current;
    if (!visible) {
      // Hidden, holding a context: last in the line to yield one.
      if (give) {
        hiddenGraphics.delete(id);
        hiddenGraphics.set(id, give);
      }
      return;
    }
    hiddenGraphics.delete(id);
    if (loadGraphics()) return;
    // The allocator is full of terminals, some hidden: the one hidden
    // longest yields — after the swap paints, because its renderer rebuild
    // is exactly the cost the swap must not pay.
    const key = `gl:${id}`;
    deferTerminalWork(key, () => {
      if (!visibleRef.current || giveGraphicsRef.current) return;
      if (reclaimHiddenGraphics()) loadGraphics();
    });
    return () => cancelTerminalWork(key);
  }, [visible, xt, id, loadGraphics]);

  // Settings → Terminal applies live: a new size re-fits the grid.
  useEffect(() => {
    const apply = (event: Event) => {
      const prefs = (event as CustomEvent<TerminalPrefs>).detail ?? readTerminalPrefs();
      const term = termRef.current;
      if (!term) return;
      term.options.fontFamily = terminalFamily(prefs);
      term.options.fontSize = prefs.size;
      term.options.lineHeight = prefs.lineHeight;
      if (visibleRef.current) fitRef.current?.fit();
    };
    window.addEventListener(TERMINAL_PREFS_EVENT, apply);
    return () => window.removeEventListener(TERMINAL_PREFS_EVENT, apply);
  }, []);

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
  // and tell the PTY its real size — on a later frame, through the deferred
  // terminal work, so a wall showing seven tiles at once spreads their drains,
  // fits and repaints across frames instead of stacking them in one, and so a
  // swap's own frame paints first (lib/terminalSwap).
  useEffect(() => {
    if (!visible) return;
    const key = `show:${id}`;
    deferTerminalWork(key, () => {
      // This fit is the one the swap's resizes were waiting for.
      cancelTerminalWork(`fit:${id}`);
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
      // Explicit user opens (caret, a sidebar row, a tab switch) focus the
      // terminal; programmatic reveals arm the suppress window and don't,
      // and nothing takes the caret from where the user is writing.
      const host = hostRef.current;
      if (host && revealMayFocus(host)) term?.focus();
    });
    return () => cancelTerminalWork(key);
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
