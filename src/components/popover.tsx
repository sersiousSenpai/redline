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
import {
  placeByRect,
  viewportBounds,
  type AnchorRect,
} from "../lib/anchorPlacement";
import { rafCoalesce } from "../lib/raf";
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
/** Anchor edge to panel edge. */
const GAP = 6;
/** Keep-out from the viewport edges. */
const MARGIN = 8;
/** The height a panel is ASSUMED to want, for the one decision that has to be
 *  made before the panel exists: which side of the anchor to open on.
 *
 *  There is no box to measure at click time, so the side has to be chosen
 *  against a guess. Too small and a long menu stays below a low anchor and
 *  overhangs; too large and a three-row menu flips above for no reason. ~320px
 *  is seven rows: past that the panel is scrolling regardless, and it is
 *  `maxHeight` — not the side — that makes the overflow reachable. */
const ASSUMED_PANEL_HEIGHT = 320;

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
        // A COLUMN, so a `maxHeight` arriving through `style` (the placement
        // helpers emit one) is a real bound: header and footer keep their
        // natural height and the scrolling middle child takes the rest.
        // `overflow: hidden` stays — it is what rounds the corners.
        display: "flex",
        flexDirection: "column",
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
        // Pinned: in a bounded column the scroller yields, not the chrome.
        flexShrink: 0,
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
        flexShrink: 0,
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

/** The shared body of `placeUnder` / `placeOver`: pick a side that has room,
 *  clamp horizontally, and say how tall the panel may be.
 *
 *  These used to clamp the HORIZONTAL axis only. `top` was unconditionally
 *  `anchor.bottom + 6` with no vertical fit and no flip, so a trigger low in
 *  the window opened a menu that ran off the bottom edge — and since the panel
 *  is `position: fixed`, nothing could scroll the overhang back. The rows
 *  rendered last were simply unreachable. `placeByRect` already does the flip
 *  honestly, and now also reports the room it landed in. */
function place(
  anchor: HTMLElement | null,
  align: "left" | "right",
  width: number,
  prefer: "below" | "above",
): CSSProperties | null {
  const r = anchor?.getBoundingClientRect();
  if (!r) return null;
  // `placeByRect` aligns to its target's LEFT edge, which is the whole of
  // `align: "left"`. `align: "right"` is expressed by handing it a target
  // already shifted so that edge falls where the right-hung panel wants it —
  // rather than teaching the shared helper a second alignment mode.
  const rawLeft = align === "left" ? r.left : r.right - width;
  const target: AnchorRect = {
    left: rawLeft,
    top: r.top,
    right: rawLeft + width,
    bottom: r.bottom,
  };
  const p = placeByRect(
    target,
    { width, height: ASSUMED_PANEL_HEIGHT },
    { bounds: viewportBounds(), prefer, gap: GAP, margin: MARGIN },
  );

  // Landing above is expressed as `bottom`, not `top`. The panel's real height
  // is only knowable after it renders, so anchoring the edge that TOUCHES the
  // anchor lets it grow upward from there whatever that height turns out to be
  // — which is what the old `placeOver` got right and is worth keeping. (It is
  // also why `p.top` goes unused here: that number was computed against
  // ASSUMED_PANEL_HEIGHT, a guess, while `p.side` and `p.maxHeight` are facts
  // about the room.)
  const vertical: CSSProperties =
    p.side === "above"
      ? { bottom: `${window.innerHeight - r.top + GAP}px` }
      : { top: `${r.bottom + GAP}px` };

  return { left: `${p.left}px`, ...vertical, maxHeight: `${p.maxHeight}px` };
}

/** Place a fixed panel under `anchor`, inside the viewport — flipping ABOVE
 *  when there isn't room below.
 *  `align: "right"` hangs it off the anchor's right edge (an overflow menu).
 *  `width` must be the width the panel will actually render at — a style-only
 *  override on the panel would desync this clamp from the real width and hang
 *  the panel off the right edge, which is exactly what PANEL_WIDTH being a
 *  shared constant exists to prevent.
 *
 *  The returned style carries a `maxHeight`: the room actually there on the
 *  chosen side. A panel that wants to scroll should spend THAT on its
 *  scroller rather than a `60vh` fraction of a window it isn't measured
 *  against.
 *
 *  Note for callers that read the result's keys rather than spreading it: a
 *  flip returns `bottom` instead of `top`. Spreading into a style is always
 *  safe; indexing `.top` is not. */
export function placeUnder(
  anchor: HTMLElement | null,
  align: "left" | "right",
  width: number = PANEL_WIDTH,
): CSSProperties | null {
  return place(anchor, align, width, "below");
}

/** Place a fixed panel *above* `anchor` (a bottom-anchored footer button),
 *  flipping BELOW when the anchor is too near the top. Same `maxHeight`
 *  contract as `placeUnder`. */
export function placeOver(
  anchor: HTMLElement | null,
  align: "left" | "right",
  width: number = PANEL_WIDTH,
): CSSProperties | null {
  return place(anchor, align, width, "above");
}

/** Keep an OPEN panel's placement honest.
 *
 *  A menu placed on the click that opened it is correct for exactly that
 *  instant. Resize the window under it, or scroll the strip its trigger lives
 *  in, and it is stranded at coordinates the anchor has left. Costs nothing
 *  while closed — the effect doesn't subscribe — and one rAF-coalesced measure
 *  per frame while open.
 *
 *  `capture: true` for the reason AnchoredOverlay documents: the scroll that
 *  moves the anchor happens on an ancestor container, and a bubbling window
 *  listener never sees it. */
function useReplaceWhileOpen(
  open: boolean,
  compute: () => CSSProperties | null,
  setStyle: React.Dispatch<React.SetStateAction<CSSProperties>>,
) {
  // Held in a ref so a fresh closure each render doesn't re-subscribe.
  const computeRef = useRef(compute);
  computeRef.current = compute;

  useEffect(() => {
    if (!open) return;
    const measure = () => {
      const next = computeRef.current();
      if (!next) return;
      // Same-place re-placements are the common case — scrolling the menu's
      // OWN list fires this listener too. Bailing keeps a scroll from
      // re-rendering a long panel on every frame.
      setStyle((prev) => (samePlacement(prev, next) ? prev : next));
    };
    const onFrame = rafCoalesce(measure);
    window.addEventListener("resize", onFrame);
    window.addEventListener("scroll", onFrame, true);
    return () => {
      onFrame.cancel();
      window.removeEventListener("resize", onFrame);
      window.removeEventListener("scroll", onFrame, true);
    };
  }, [open, setStyle]);
}

function samePlacement(a: CSSProperties, b: CSSProperties): boolean {
  return (
    a.left === b.left &&
    a.top === b.top &&
    a.bottom === b.bottom &&
    a.width === b.width &&
    a.maxHeight === b.maxHeight
  );
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
  useReplaceWhileOpen(
    open,
    () => placeUnder(anchorRef.current, "left"),
    setStyle,
  );

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

/** An anchored popover holding a single text input — the app's replacement for
 *  `window.prompt`, which WKWebView implements as A SILENT NULL. Anywhere the
 *  packaged app calls `window.prompt` the feature is simply dead: the user
 *  types nothing, sees nothing, and the code reads a null it treats as
 *  "cancelled".
 *
 *  Unlike a menu panel this must NOT suppress mousedown — the input has to take
 *  focus. ProseMirror keeps its selection while the editor is blurred, and the
 *  commit path re-focuses it. */
export function InlineInputPopover({
  title,
  placeholder,
  initialValue,
  commitLabel,
  onCommit,
  onClose,
}: {
  title: string;
  placeholder?: string;
  initialValue: string;
  /** Shown as a button beside the input. Omit for Enter-only (the ribbon's
   *  original shape). */
  commitLabel?: string;
  onCommit: (value: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const close = useCallback(() => onClose(), [onClose]);
  useDismiss(true, close, [rootRef]);

  const commit = () => {
    onCommit(value);
    onClose();
  };

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-label={title}
      className="rl-ribbon-pop"
      style={{ minWidth: "240px", padding: "8px" }}
    >
      <div
        style={{
          fontSize: "11px",
          color: "var(--color-ink-muted)",
          marginBottom: "6px",
        }}
      >
        {title}
      </div>
      <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
        <input
          ref={inputRef}
          type="text"
          value={value}
          placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            // The host may be an editor with its own global bindings.
            e.stopPropagation();
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
          className="rl-search-input"
          style={{ width: "100%" }}
        />
        {commitLabel && (
          <button
            type="button"
            onClick={commit}
            disabled={!value.trim()}
            className="rounded px-2 py-1"
            style={{
              fontSize: "11px",
              whiteSpace: "nowrap",
              background: "var(--color-info)",
              color: "var(--color-on-accent)",
              opacity: value.trim() ? 1 : 0.5,
              cursor: value.trim() ? "pointer" : "default",
            }}
          >
            {commitLabel}
          </button>
        )}
      </div>
    </div>
  );
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
  // One expression for both the opening placement and every re-placement, so
  // the two can't drift.
  const measure = (): CSSProperties | null => {
    const pos =
      side === "above"
        ? placeOver(anchorRef.current, align, width)
        : placeUnder(anchorRef.current, align, width);
    // Panel spreads this style LAST, so the width here wins over its default.
    return pos && { ...pos, width: `${width}px` };
  };
  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    const pos = measure();
    if (!pos) return;
    setStyle(pos);
    setOpen(true);
  };

  useDismiss(open, close, [anchorRef, panelRef]);
  useReplaceWhileOpen(open, measure, setStyle);

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
