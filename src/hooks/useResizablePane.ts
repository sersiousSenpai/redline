// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useCallback, useEffect, useRef, useState } from "react";

import {
  beginResizeSession,
  endResizeSession,
} from "../lib/resizeSession";

type Axis = "x" | "y";

interface Options {
  /** Current size in px (width for axis "x", height for axis "y"). */
  width: number;
  onWidthChange: (next: number) => void;
  /** Live per-frame size during the drag. When supplied the rAF flush calls
   *  THIS instead of `onWidthChange`, and `onWidthChange` fires exactly once —
   *  on release, with the rest value. That's how a drag frame can cost one CSS
   *  custom-property write and no React render at all: the host writes the live
   *  size to a variable descendants already read, and only the resting value
   *  ever becomes state. Omit it and the hook behaves exactly as before. */
  onLiveSize?: (next: number) => void;
  /** "x" = right-hand pane (default), "y" = bottom dock. */
  axis?: Axis;
  /** Which edge the pane occupies. "trailing" (default) panes sit at the
   *  right/bottom with the divider on their leading edge, so they grow as the
   *  pointer moves *toward* the document (size = start - delta). "leading"
   *  panes (e.g. the left sidebar) have the divider on their trailing edge and
   *  grow as the pointer moves *away* (size = start + delta). */
  side?: "leading" | "trailing";
  min?: number;
  max?: number;
  /** Called when the user keeps dragging *past* the hard stop (`min`) far
   *  enough to dismiss the pane — it snaps closed instead of resting at min.
   *  Omit to disable snap-to-close (pane just clamps at min). */
  onCollapse?: () => void;
  /** How far past `min` (px) the pointer must travel before the snap fires.
   *  Keeps the resting hard stop comfortable while still allowing a deliberate
   *  drag-through to close. Default 56. */
  collapseOvershoot?: number;
  /** True when the pane is currently collapsed. Dragging its divider then
   *  re-opens it: the pane snaps to `min` and tracks the pointer from there, so
   *  the user doesn't have to hunt for the small caret. */
  collapsed?: boolean;
  /** Re-open a collapsed pane (clear its collapsed flag). Paired with
   *  `collapsed` to enable drag-from-edge reopen. */
  onExpand?: () => void;
}

const clamp = (n: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, n));

// Drag-to-resize. Both panes grow as the pointer moves *toward* the document
// (left for the comment pane, up for the bottom terminal dock), so
// size = startSize - delta. Listeners live on `window` so a fast drag that
// leaves the divider still tracks.
export function useResizablePane({
  width,
  onWidthChange,
  onLiveSize,
  axis = "x",
  side = "trailing",
  min = 240,
  max,
  onCollapse,
  collapseOvershoot = 56,
  collapsed = false,
  onExpand,
}: Options) {
  const [isDragging, setDragging] = useState(false);
  // True while the post-release "settle to min" CSS transition is playing, so
  // the host can enable a width transition only for that moment (never during
  // the live drag, which must track the pointer 1:1).
  const [settling, setSettling] = useState(false);
  const start = useRef({ pos: 0, size: 0 });
  // True while a collapsed→open reveal drag is in progress (lower clamp drops to
  // 0 so the drawer can be pulled partway), plus the last width seen so release
  // can decide whether to settle open.
  const reopening = useRef(false);
  const lastWidth = useRef(0);
  const settleTimer = useRef<number | undefined>(undefined);
  // Our own contribution to the app-wide resize refcount, latched so that
  // however the drag ends — pointerup, a snap-to-close, an unmount mid-drag —
  // we release exactly the one session we opened.
  const sessionOpen = useRef(false);
  const openSession = useCallback(() => {
    if (sessionOpen.current) return;
    sessionOpen.current = true;
    beginResizeSession();
  }, []);
  const closeSession = useCallback(() => {
    if (!sessionOpen.current) return;
    sessionOpen.current = false;
    endResizeSession();
  }, []);
  // The upper clamp, resolved once at drag start. It reads
  // `window.innerWidth/Height`, and it used to be called from `onMove` — i.e. at
  // raw pointer rate, above the frame rate, for a value that cannot change
  // during the drag.
  const maxRef = useRef(Infinity);
  // Latest live callback, read by the drag effect without re-subscribing its
  // window listeners when the host re-renders with a new closure.
  const onLiveSizeRef = useRef(onLiveSize);
  onLiveSizeRef.current = onLiveSize;

  const maxSize = useCallback(() => {
    if (max != null) return max;
    // Side panes can grow to nearly the full viewport, leaving 320px for the
    // primary surface (the editor for axis "x", the editor stack above the
    // bottom dock for axis "y"). The pane also has its own fullscreen toggle
    // for the rare case where 320px isn't enough headroom.
    return axis === "x"
      ? Math.max(
          320,
          Math.min(
            window.innerWidth - 320,
            Math.round(window.innerWidth * 0.9),
          ),
        )
      : Math.max(
          120,
          Math.min(
            window.innerHeight - 200,
            Math.round(window.innerHeight * 0.85),
          ),
        );
  }, [axis, max]);

  const startDrag = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      // Dragging the divider of a collapsed pane re-opens it as a drawer: the
      // pane starts at width 0 and tracks the pointer (content stays pinned at
      // min and is clipped), so it unfolds under the cursor instead of snapping.
      let startSize = width;
      if (collapsed && onExpand) {
        if (settleTimer.current) window.clearTimeout(settleTimer.current);
        setSettling(false);
        onExpand();
        onWidthChange(0);
        startSize = 0;
        reopening.current = true;
      } else {
        reopening.current = false;
      }
      start.current = {
        pos: axis === "x" ? e.clientX : e.clientY,
        size: startSize,
      };
      // Seed the rest value so a press-and-release with no movement commits the
      // size it started at rather than whatever the previous drag left behind.
      lastWidth.current = startSize;
      maxRef.current = maxSize();
      openSession();
      setDragging(true);
    },
    [axis, width, collapsed, onExpand, onWidthChange, maxSize, openSession],
  );

  useEffect(() => {
    if (!isDragging) return;

    const sign = side === "leading" ? 1 : -1;
    // Coalesce pointer moves to one commit per animation frame. Pointer events
    // can fire well above the display refresh rate (120Hz+ trackpads), and each
    // commit costs at minimum a layout pass; without this a fast drag flushes
    // several times per frame for no visual gain. `lastWidth` always holds the
    // latest target, so the rAF flush applies the freshest value.
    //
    // `snappedClosed` marks a drag-through past the hard stop that dismissed the
    // pane. The pointerup that follows must NOT then commit the sub-minimum
    // width the pointer was sitting at — the pane is closed, and that width is
    // meaningless.
    let snappedClosed = false;
    let rafId = 0;
    const flush = () => {
      rafId = 0;
      const live = onLiveSizeRef.current;
      if (live) live(lastWidth.current);
      else onWidthChange(lastWidth.current);
    };
    const onMove = (e: PointerEvent) => {
      const cur = axis === "x" ? e.clientX : e.clientY;
      const delta = cur - start.current.pos;
      const intended = start.current.size + sign * delta;
      // Drag-through past the hard stop dismisses the pane: it rests at `min`,
      // but pushing `collapseOvershoot` px further snaps it closed and ends the
      // drag (so it can't immediately re-resize from under the pointer). Skipped
      // while re-opening (the drawer is allowed below min during the reveal).
      if (!reopening.current && onCollapse && intended < min - collapseOvershoot) {
        if (rafId) {
          cancelAnimationFrame(rafId);
          rafId = 0;
        }
        snappedClosed = true;
        setDragging(false);
        closeSession();
        onCollapse();
        return;
      }
      // While re-opening, the lower bound is 0 so the drawer can be pulled
      // partway; otherwise it's the normal `min` hard stop.
      const lower = reopening.current ? 0 : min;
      const next = clamp(intended, lower, maxRef.current);
      lastWidth.current = next;
      if (!rafId) rafId = requestAnimationFrame(flush);
    };
    const onUp = () => {
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
      // The one React commit of the whole drag when a live path is in use:
      // every frame before this went to `onLiveSize` and touched no state.
      // Without one, only the pending frame (if any) was ever committed.
      if (!snappedClosed) onWidthChange(lastWidth.current);
      setDragging(false);
      // Releasing a partway drawer settles it smoothly open to min.
      if (reopening.current) {
        reopening.current = false;
        if (lastWidth.current < min) {
          setSettling(true);
          onWidthChange(min);
          settleTimer.current = window.setTimeout(
            () => setSettling(false),
            180,
          );
        }
      }
      // Last, so every consumer that defers work to the end of the drag (the
      // terminal's re-fit, the latch/zoom recomputations) runs against the
      // committed rest size rather than the frame before it.
      closeSession();
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = axis === "x" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
      // NOTE: the session is deliberately NOT closed here. This effect
      // re-subscribes whenever the host re-renders with a fresh `onCollapse`
      // closure, and closing on every teardown would drop the refcount to 0
      // mid-drag — unfreezing the terminal and re-running every gated effect.
      // The three real ends (pointerup, snap-to-close, unmount) close it.
    };
  }, [
    isDragging,
    axis,
    side,
    min,
    onWidthChange,
    onCollapse,
    collapseOvershoot,
    closeSession,
  ]);

  // Clear any pending settle timer on unmount, and release a session that
  // somehow outlived its drag.
  useEffect(
    () => () => {
      if (settleTimer.current) window.clearTimeout(settleTimer.current);
      closeSession();
    },
    [closeSession],
  );

  return { isDragging, startDrag, settling };
}
