// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useEffect, useRef } from "react";
import { invoke, Channel } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { contrastRatio, luminance, mix } from "../theme/derive";
import { getTheme, type AnsiSlot } from "../theme/themes";

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
  /** Called when the user clicks into this pane — lets the host mark which of
   *  two split panes is the focused/"active" terminal. */
  onPaneFocus?: () => void;
}

// POSIX single-quote escaping so paths with spaces/quotes paste safely.
function shellQuote(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
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
export function TerminalView({
  id,
  cwd,
  theme,
  visible,
  onActivity,
  onExit,
  onPaneFocus,
}: TerminalViewProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  // The mount effect runs once ([]-deps, "spawn once"), so anything it closes
  // over goes stale. Mirror the live values into refs it can read each tick.
  const visibleRef = useRef(visible);
  const onActivityRef = useRef(onActivity);
  const onExitRef = useRef(onExit);
  visibleRef.current = visible;
  onActivityRef.current = onActivity;
  onExitRef.current = onExit;

  // Create the terminal + PTY once.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

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

    // GPU renderer: offloads cell rendering to WebGL so a fast stream doesn't
    // peg the main thread compositing the DOM. WebGL can fail to init on some
    // GPUs/contexts and the context can be lost at runtime — both cases fall
    // back to xterm's default renderer rather than breaking the terminal.
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {
      /* no WebGL here — xterm's default renderer stays active */
    }

    // Per-terminal raw-byte output stream. One Channel = one subscriber (this
    // tab) → no N-tab event fan-out, no id filtering, no base64. Bytes arrive
    // as an ArrayBuffer; write them straight to xterm. The write callback is our
    // flow-control ACK — it fires once xterm has parsed the chunk, so we report
    // the byte count back and the backend only keeps reading while we keep up.
    const onOutput = new Channel<ArrayBuffer>();
    onOutput.onmessage = (buf) => {
      const bytes = new Uint8Array(buf);
      term.write(bytes, () => {
        void invoke("pty_ack", { id, n: bytes.length }).catch(() => {});
      });
      if (!visibleRef.current) onActivityRef.current(id);
    };

    // A hidden (display:none / zero-height) host makes fit() compute 0×0; a
    // 0-row PTY corrupts output. Fall back to a sane size when spawning while
    // not yet visible — the [visible] effect re-fits once shown.
    void invoke("pty_spawn", {
      id,
      cwd,
      cols: term.cols || 80,
      rows: term.rows || 24,
      onOutput,
    }).catch((e) => term.writeln(`\r\n[redline: failed to start shell: ${e}]`));

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

      // Only act when the drop lands over the terminal host element.
      const h = hostRef.current;
      if (h) {
        const r = h.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const x = event.payload.position.x / dpr;
        const y = event.payload.position.y / dpr;
        if (x < r.left || x > r.right || y < r.top || y > r.bottom) return;
      }

      const text = paths.map(shellQuote).join(" ") + " ";
      void invoke("pty_write", { id, data: text }).catch(() => {});
      termRef.current?.focus();
    });

    const ro = new ResizeObserver(() => {
      // A hidden or zero-sized view yields 0 cols/rows; never push that to the
      // PTY (it corrupts output). The [visible] effect re-fits when shown.
      if (!visibleRef.current || term.rows === 0 || term.cols === 0) return;
      try {
        fit.fit();
        if (term.cols > 0 && term.rows > 0) {
          void invoke("pty_resize", {
            id,
            cols: term.cols,
            rows: term.rows,
          }).catch(() => {});
        }
      } catch {
        /* host detached mid-resize */
      }
    });
    ro.observe(host);

    // After the OS app returns from the background, a still-`visible` terminal
    // gets no `visible` transition to re-fit/re-focus it — and a webview that
    // was backgrounded can leave the xterm renderer stale and the pane
    // unfocused. Re-fit, repaint and refocus on every window-focus regain so
    // the terminal never strands the user.
    const focusPromise = getCurrentWindow().onFocusChanged(
      ({ payload: focused }) => {
        if (!focused || !visibleRef.current) return;
        requestAnimationFrame(() => {
          const term = termRef.current;
          if (!term) return;
          try {
            fitRef.current?.fit();
          } catch {
            /* host detached */
          }
          if (term.cols > 0 && term.rows > 0) {
            void invoke("pty_resize", {
              id,
              cols: term.cols,
              rows: term.rows,
            }).catch(() => {});
            term.refresh(0, term.rows - 1);
          }
          term.focus();
        });
      },
    );

    return () => {
      ro.disconnect();
      dataSub.dispose();
      void exitPromise.then((un) => un());
      void dropPromise.then((un) => un());
      void focusPromise.then((un) => un());
      void invoke("pty_kill", { id }).catch(() => {});
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // Spawn once for this tab's lifetime; cwd/theme/visibility are applied via
    // the effects below (and refs) without re-forking the shell.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-theme in place when the app theme changes.
  useEffect(() => {
    const term = termRef.current;
    if (term) term.options.theme = readXtermTheme(theme);
  }, [theme]);

  // Becoming visible: the host had no usable geometry while hidden, so re-fit
  // on the next frame and tell the PTY its real size.
  useEffect(() => {
    if (!visible) return;
    const raf = requestAnimationFrame(() => {
      const term = termRef.current;
      try {
        fitRef.current?.fit();
      } catch {
        /* host detached */
      }
      if (term && term.cols > 0 && term.rows > 0) {
        void invoke("pty_resize", {
          id,
          cols: term.cols,
          rows: term.rows,
        }).catch(() => {});
        // Force a renderer repaint — a pane that was hidden (display:none)
        // can come back with a stale xterm render surface.
        term.refresh(0, term.rows - 1);
      }
      term?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [visible, id]);

  return (
    <div
      className="h-full w-full overflow-hidden"
      // Guaranteed click-to-focus: a click anywhere in the pane re-acquires
      // xterm focus even if xterm's own mousedown handling is in a bad state
      // after a background/visibility cycle.
      onPointerDown={() => {
        onPaneFocus?.();
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
}
