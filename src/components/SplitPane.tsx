// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useRef, type ReactNode } from "react";

import { rafCoalesce } from "../lib/raf";
import { beginResizeSession, endResizeSession } from "../lib/resizeSession";

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

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

// A two-pane split that can lay out as a row or a column, with a divider that
// resizes the panes and can be dragged all the way to either edge to fold one
// pane shut. Sizing is ratio-based so it survives orientation flips.
//
// The live ratio is written straight onto the first pane's flex-basis, so a
// drag frame costs one style write plus layout and never re-renders either
// subtree. Deliberately NOT a custom property on the container: those are
// inherited, so changing one per frame would invalidate style for everything
// inside the split — which here is the whole document or browser pane.
// The `ratio` prop stays the source of truth between drags; the drag commits
// exactly once, on release.
export function SplitPane({
  vertical,
  ratio,
  onRatioChange,
  onDraggingChange,
  first,
  second,
}: SplitPaneProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const firstRef = useRef<HTMLDivElement | null>(null);

  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    const el = containerRef.current;
    if (!el) return;
    // Capture, so a fast drag that leaves the 6px handle keeps tracking and the
    // gesture can't be stolen mid-flight (matching TerminalSplitDivider).
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    onDraggingChange?.(true);
    beginResizeSession();
    // Hoisted out of the move handler: the container's rect cannot change
    // during the drag, and reading it per raw pointer event forced a layout at
    // pointer rate — above the frame rate, outside the rAF gate.
    const rect = el.getBoundingClientRect();
    const size = vertical ? rect.height : rect.width;
    const origin = vertical ? rect.top : rect.left;

    let pending = ratio;
    const apply = rafCoalesce((r: number) => {
      if (firstRef.current) firstRef.current.style.flexBasis = `${r * 100}%`;
    });
    const move = (ev: PointerEvent) => {
      const pos = vertical ? ev.clientY : ev.clientX;
      let r = size > 0 ? (pos - origin) / size : 0.5;
      r = clamp01(r);
      if (r < 0.04) r = 0; // fold the first pane shut
      else if (r > 0.96) r = 1; // fold the second pane shut
      pending = r;
      apply(r);
    };
    const up = () => {
      apply.cancel();
      // Land the exact rest position before the commit, so there is no frame
      // where the DOM and the state disagree.
      if (firstRef.current) {
        firstRef.current.style.flexBasis = `${pending * 100}%`;
      }
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      onRatioChange(pending);
      onDraggingChange?.(false);
      endResizeSession();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div
      ref={containerRef}
      className={`flex-1 min-w-0 min-h-0 flex ${
        vertical ? "flex-col" : "flex-row"
      }`}
    >
      <div
        ref={firstRef}
        className="flex flex-col overflow-hidden min-w-0 min-h-0"
        style={{
          flexGrow: 0,
          flexShrink: 0,
          flexBasis: `${clamp01(ratio) * 100}%`,
        }}
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
          // Never let the OS interpret the drag as a scroll/pan gesture.
          touchAction: "none",
        }}
      />
      <div className="flex flex-col overflow-hidden min-w-0 min-h-0 flex-1">
        {second}
      </div>
    </div>
  );
}
