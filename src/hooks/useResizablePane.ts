// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useCallback, useEffect, useRef, useState } from "react";

type Axis = "x" | "y";

interface Options {
  /** Current size in px (width for axis "x", height for axis "y"). */
  width: number;
  onWidthChange: (next: number) => void;
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
        lastWidth.current = 0;
      } else {
        reopening.current = false;
      }
      start.current = {
        pos: axis === "x" ? e.clientX : e.clientY,
        size: startSize,
      };
      setDragging(true);
    },
    [axis, width, collapsed, onExpand, onWidthChange],
  );

  useEffect(() => {
    if (!isDragging) return;

    const sign = side === "leading" ? 1 : -1;
    const onMove = (e: PointerEvent) => {
      const cur = axis === "x" ? e.clientX : e.clientY;
      const delta = cur - start.current.pos;
      const intended = start.current.size + sign * delta;
      // Drag-through past the hard stop dismisses the pane: it rests at `min`,
      // but pushing `collapseOvershoot` px further snaps it closed and ends the
      // drag (so it can't immediately re-resize from under the pointer). Skipped
      // while re-opening (the drawer is allowed below min during the reveal).
      if (!reopening.current && onCollapse && intended < min - collapseOvershoot) {
        setDragging(false);
        onCollapse();
        return;
      }
      // While re-opening, the lower bound is 0 so the drawer can be pulled
      // partway; otherwise it's the normal `min` hard stop.
      const lower = reopening.current ? 0 : min;
      const next = clamp(intended, lower, maxSize());
      lastWidth.current = next;
      onWidthChange(next);
    };
    const onUp = () => {
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
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = axis === "x" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";

    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
    };
  }, [
    isDragging,
    axis,
    side,
    min,
    maxSize,
    onWidthChange,
    onCollapse,
    collapseOvershoot,
  ]);

  // Clear any pending settle timer on unmount.
  useEffect(
    () => () => {
      if (settleTimer.current) window.clearTimeout(settleTimer.current);
    },
    [],
  );

  return { isDragging, startDrag, settling };
}
