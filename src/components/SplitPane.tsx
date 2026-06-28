// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useRef, type ReactNode } from "react";

interface SplitPaneProps {
  /** false = side-by-side (row, the default); true = stacked (column). */
  vertical: boolean;
  /** Fraction (0..1) of the space given to the first pane. 0 folds the first
   *  all the way; 1 folds the second all the way. */
  ratio: number;
  onRatioChange: (next: number) => void;
  /** Fired on drag start/end. The host uses it to hide a native child webview
   *  during the drag — otherwise the webview swallows the pointer mid-drag and
   *  the resize freezes. */
  onDraggingChange?: (dragging: boolean) => void;
  first: ReactNode;
  second: ReactNode;
}

// A two-pane split that can lay out as a row or a column, with a divider that
// resizes the panes and can be dragged all the way to either edge to fold one
// pane shut. Sizing is ratio-based so it survives orientation flips.
export function SplitPane({
  vertical,
  ratio,
  onRatioChange,
  onDraggingChange,
  first,
  second,
}: SplitPaneProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    const el = containerRef.current;
    if (!el) return;
    onDraggingChange?.(true);
    const move = (ev: PointerEvent) => {
      const rect = el.getBoundingClientRect();
      const size = vertical ? rect.height : rect.width;
      const start = vertical ? rect.top : rect.left;
      const pos = vertical ? ev.clientY : ev.clientX;
      let r = size > 0 ? (pos - start) / size : 0.5;
      r = Math.max(0, Math.min(1, r));
      if (r < 0.04) r = 0; // fold the first pane shut
      else if (r > 0.96) r = 1; // fold the second pane shut
      onRatioChange(r);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      onDraggingChange?.(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const pct = Math.max(0, Math.min(1, ratio)) * 100;

  return (
    <div
      ref={containerRef}
      className={`flex-1 min-w-0 min-h-0 flex ${
        vertical ? "flex-col" : "flex-row"
      }`}
    >
      <div
        className="flex flex-col overflow-hidden min-w-0 min-h-0"
        style={{ flex: `0 0 ${pct}%` }}
      >
        {first}
      </div>
      <div
        onPointerDown={startDrag}
        onDoubleClick={() => onRatioChange(0.5)}
        title="Drag to resize · drag to an edge to fold · double-click to even"
        className="rl-split-divider shrink-0"
        style={{
          flex: "0 0 6px",
          cursor: vertical ? "row-resize" : "col-resize",
          background: "var(--color-rule)",
        }}
      />
      <div className="flex flex-col overflow-hidden min-w-0 min-h-0 flex-1">
        {second}
      </div>
    </div>
  );
}
