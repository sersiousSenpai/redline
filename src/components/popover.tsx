// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import { useMenuOverlay } from "./menuOverlay";

// The floating-panel idiom extracted from RepoBubbles (a pure move): a
// viewport-fixed, body-portalled panel with hover- and click-opened variants,
// shared dismissal, and placement clamped inside the viewport. Anything that
// needs a popover which must escape an `overflow: hidden` strip or a
// `contain: layout paint` wrapper builds on these.

/** Panel width, px — placement math and the panel itself must agree on it. */
export const PANEL_WIDTH = 272;
// Long enough that sweeping the pointer across a strip on the way elsewhere
// doesn't fire a panel; short enough to feel like a hover.
const OPEN_DELAY_MS = 320;
// Grace period so the pointer can travel from the anchor into the panel.
const CLOSE_DELAY_MS = 160;

export interface PanelProps {
  label: string;
  style: CSSProperties;
  panelRef: (el: HTMLDivElement | null) => void;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
  children: React.ReactNode;
}

/** The floating panel both popovers share. Two escapes, for two different
 *  clips:
 *
 *  - `position: fixed`, because a 30px `overflow: hidden` bar (the terminal
 *    tab strip) would cut an absolutely positioned panel off at its edge.
 *  - a portal to `document.body`, because a wrapper carrying
 *    `contain: layout paint` (`.rl-term-dock`, styles.css) becomes the
 *    containing block for *fixed* descendants too, and paint containment then
 *    clips them — a panel left inside is positioned against the wrapper's box
 *    and clipped to it, i.e. invisible. Portalling out of the contained
 *    subtree restores viewport coordinates.
 *
 *  Styling follows the header dropdowns (LiveSessionMenu). */
export function Panel({
  label,
  style,
  panelRef,
  onPointerEnter,
  onPointerLeave,
  children,
}: PanelProps) {
  return createPortal(
    <div
      ref={panelRef}
      role="menu"
      aria-label={label}
      className="rounded-md overflow-hidden font-sans"
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      style={{
        position: "fixed",
        zIndex: 60,
        width: `${PANEL_WIDTH}px`,
        border: "1px solid var(--color-rule)",
        background: "var(--color-bg-elevated)",
        boxShadow: "0 8px 24px rgba(0,0,0,0.28)",
        ...style,
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

/** The panel's context line (RepoBubbles: the repo's full path). `direction:
 *  rtl` truncates from the *left*, so a deep path keeps the tail that
 *  identifies it; the bidi isolate keeps the slashes reading in their real
 *  order. */
export function PanelHeader({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="truncate px-3 py-1.5 font-sans"
      style={{
        fontSize: "10px",
        color: "var(--color-ink-muted)",
        borderBottom: "1px solid var(--color-rule)",
        direction: "rtl",
        textAlign: "left",
      }}
    >
      <bdi>{children}</bdi>
    </div>
  );
}

export function PanelFooter({
  children,
  onClick,
}: {
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="rl-menu-item w-full text-left px-3 py-1.5 font-sans"
      style={{
        display: "block",
        fontSize: "11px",
        color: "var(--color-ink-muted)",
        borderTop: "1px solid var(--color-rule)",
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}

/** Place a fixed panel under `anchor`, clamped inside the viewport.
 *  `align: "right"` hangs it off the anchor's right edge (an overflow menu).
 *  `width` must be the width the panel will actually render at — a style-only
 *  override on the panel would desync this clamp from the real width and hang
 *  the panel off the right edge, which is exactly what PANEL_WIDTH being a
 *  shared constant exists to prevent. */
export function placeUnder(
  anchor: HTMLElement | null,
  align: "left" | "right",
  width: number = PANEL_WIDTH,
): CSSProperties | null {
  const r = anchor?.getBoundingClientRect();
  if (!r) return null;
  const raw = align === "left" ? r.left : r.right - width;
  const left = Math.max(8, Math.min(raw, window.innerWidth - width - 8));
  return { left: `${left}px`, top: `${r.bottom + 6}px` };
}

/** Place a fixed panel *above* `anchor` (a bottom-anchored footer button).
 *  Positioned with `bottom` rather than `top` so the panel grows upward from
 *  the anchor whatever its content height turns out to be. */
export function placeOver(
  anchor: HTMLElement | null,
  align: "left" | "right",
  width: number = PANEL_WIDTH,
): CSSProperties | null {
  const r = anchor?.getBoundingClientRect();
  if (!r) return null;
  const raw = align === "left" ? r.left : r.right - width;
  const left = Math.max(8, Math.min(raw, window.innerWidth - width - 8));
  return { left: `${left}px`, bottom: `${window.innerHeight - r.top + 6}px` };
}

/** Shared dismissal for the popovers: outside mousedown and Escape. */
export function useDismiss(
  open: boolean,
  close: () => void,
  refs: readonly React.RefObject<HTMLElement | null>[],
) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      for (const r of refs) {
        if (r.current && r.current.contains(target)) return;
      }
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
    // `refs` is a fresh array each render; its contents are stable refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, close]);
}

/** Hover-with-intent popover: a delay before opening (so crossing a strip
 *  doesn't pop panels) and a grace period before closing (so the pointer can
 *  reach the panel). */
export function useHoverPopover(anchorRef: React.RefObject<HTMLElement | null>) {
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState<CSSProperties>({});
  const panelRef = useRef<HTMLDivElement | null>(null);
  const openTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);

  useMenuOverlay(open);

  const cancel = (t: React.RefObject<number | null>) => {
    if (t.current !== null) {
      window.clearTimeout(t.current);
      t.current = null;
    }
  };

  // Timers must not outlive the anchor — it can leave the DOM mid-hover.
  useEffect(
    () => () => {
      cancel(openTimer);
      cancel(closeTimer);
    },
    [],
  );

  // Stable so the dismissal listeners below don't re-subscribe every render.
  const close = useCallback(() => {
    cancel(openTimer);
    cancel(closeTimer);
    setOpen(false);
  }, []);

  const onPointerEnter = () => {
    cancel(closeTimer);
    if (open || openTimer.current !== null) return;
    openTimer.current = window.setTimeout(() => {
      openTimer.current = null;
      const pos = placeUnder(anchorRef.current, "left");
      if (!pos) return;
      setStyle(pos);
      setOpen(true);
    }, OPEN_DELAY_MS);
  };

  const onPointerLeave = () => {
    cancel(openTimer);
    cancel(closeTimer);
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      setOpen(false);
    }, CLOSE_DELAY_MS);
  };

  useDismiss(open, close, [anchorRef, panelRef]);

  return {
    open,
    close,
    anchorProps: { onPointerEnter, onPointerLeave },
    panelProps: {
      style,
      panelRef: (el: HTMLDivElement | null) => {
        panelRef.current = el;
      },
      onPointerEnter: () => cancel(closeTimer),
      onPointerLeave,
    },
  };
}

/** Click-toggled popover. `side: "above"` is for bottom-anchored triggers
 *  (the drafter footer) — the panel hangs upward instead of off the bottom of
 *  the viewport. `width` (default PANEL_WIDTH) is threaded through both the
 *  placement clamp and the panel's style so the two can never disagree —
 *  never override `width` in Panel's `style` directly. */
export function useClickPopover(
  anchorRef: React.RefObject<HTMLElement | null>,
  align: "left" | "right",
  side: "below" | "above" = "below",
  width: number = PANEL_WIDTH,
) {
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState<CSSProperties>({});
  const panelRef = useRef<HTMLDivElement | null>(null);

  useMenuOverlay(open);

  const close = useCallback(() => setOpen(false), []);
  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    const pos =
      side === "above"
        ? placeOver(anchorRef.current, align, width)
        : placeUnder(anchorRef.current, align, width);
    if (!pos) return;
    // Panel spreads this style LAST, so the width here wins over its default.
    setStyle({ ...pos, width: `${width}px` });
    setOpen(true);
  };

  useDismiss(open, close, [anchorRef, panelRef]);

  return {
    open,
    close,
    toggle,
    panelProps: {
      style,
      panelRef: (el: HTMLDivElement | null) => {
        panelRef.current = el;
      },
    },
  };
}
