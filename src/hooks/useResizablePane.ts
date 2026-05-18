import { useCallback, useEffect, useRef, useState } from "react";

interface Options {
  width: number;
  onWidthChange: (next: number) => void;
  min?: number;
  max?: number;
}

const clamp = (n: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, n));

// Drag-to-resize for the right-hand comment pane. The pane grows when the
// pointer moves left, so width = startWidth - deltaX. Listeners live on
// `window` so a fast drag that leaves the divider still tracks.
export function useResizablePane({
  width,
  onWidthChange,
  min = 240,
  max,
}: Options) {
  const [isDragging, setDragging] = useState(false);
  const start = useRef({ x: 0, width: 0 });

  const maxWidth = useCallback(
    () => max ?? Math.min(640, Math.round(window.innerWidth * 0.6)),
    [max],
  );

  const startDrag = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      start.current = { x: e.clientX, width };
      setDragging(true);
    },
    [width],
  );

  useEffect(() => {
    if (!isDragging) return;

    const onMove = (e: PointerEvent) => {
      const delta = e.clientX - start.current.x;
      onWidthChange(clamp(start.current.width - delta, min, maxWidth()));
    };
    const onUp = () => setDragging(false);

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
    };
  }, [isDragging, min, maxWidth, onWidthChange]);

  return { isDragging, startDrag };
}
