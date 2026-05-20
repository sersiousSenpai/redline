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
  min = 240,
  max,
}: Options) {
  const [isDragging, setDragging] = useState(false);
  const start = useRef({ pos: 0, size: 0 });

  const maxSize = useCallback(() => {
    if (max != null) return max;
    return axis === "x"
      ? Math.min(640, Math.round(window.innerWidth * 0.6))
      : Math.min(720, Math.round(window.innerHeight * 0.7));
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

    const onMove = (e: PointerEvent) => {
      const cur = axis === "x" ? e.clientX : e.clientY;
      const delta = cur - start.current.pos;
      onWidthChange(clamp(start.current.size - delta, min, maxSize()));
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
  }, [isDragging, axis, min, maxSize, onWidthChange]);

  return { isDragging, startDrag };
}
