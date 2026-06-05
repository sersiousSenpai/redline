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
}: Options) {
  const [isDragging, setDragging] = useState(false);
  const start = useRef({ pos: 0, size: 0 });

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
      start.current = {
        pos: axis === "x" ? e.clientX : e.clientY,
        size: width,
      };
      setDragging(true);
    },
    [axis, width],
  );

  useEffect(() => {
    if (!isDragging) return;

    const sign = side === "leading" ? 1 : -1;
    const onMove = (e: PointerEvent) => {
      const cur = axis === "x" ? e.clientX : e.clientY;
      const delta = cur - start.current.pos;
      onWidthChange(clamp(start.current.size + sign * delta, min, maxSize()));
    };
    const onUp = () => setDragging(false);

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
  }, [isDragging, axis, side, min, maxSize, onWidthChange]);

  return { isDragging, startDrag };
}
