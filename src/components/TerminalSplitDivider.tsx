// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useRef, useState } from "react";

interface TerminalSplitDividerProps {
  /** Pane-A width as a fraction of the container (0..1). */
  ratio: number;
  onRatioChange: (ratio: number) => void;
  /** The relatively-positioned pane container this divider sits inside; used
   *  to convert pointer X into a fraction. */
  containerRef: React.RefObject<HTMLDivElement | null>;
}

// Keep both panes usably wide.
const MIN = 0.2;
const MAX = 0.8;

// A thin vertical handle at the pane-A/pane-B boundary. Container-relative (the
// app's useResizablePane/PaneDivider are viewport-anchored, wrong for an inner
// split), so it measures the container rect on each move and clamps the ratio.
export function TerminalSplitDivider({
  ratio,
  onRatioChange,
  containerRef,
}: TerminalSplitDividerProps) {
  const [dragging, setDragging] = useState(false);
  const draggingRef = useRef(false);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    draggingRef.current = true;
    setDragging(true);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!draggingRef.current) return;
    const el = containerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.width <= 0) return;
    const next = (e.clientX - r.left) / r.width;
    onRatioChange(Math.min(MAX, Math.max(MIN, next)));
  };

  const end = () => {
    draggingRef.current = false;
    setDragging(false);
  };

  return (
    <div
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      title="Drag to resize panes"
      className="absolute top-0 bottom-0"
      style={{
        // Center the 7px hit area on the boundary.
        left: `calc(${ratio * 100}% - 3px)`,
        width: "7px",
        cursor: "col-resize",
        zIndex: 10,
        touchAction: "none",
      }}
    >
      {/* The visible 1px rule, brighter while dragging. */}
      <div
        className="h-full"
        style={{
          width: "1px",
          margin: "0 auto",
          background: dragging ? "var(--color-info)" : "var(--color-rule)",
        }}
      />
    </div>
  );
}
