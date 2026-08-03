// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useEffect, useMemo, useRef, useState } from "react";

import { rafCoalesce } from "../lib/raf";
import { beginResizeSession, endResizeSession } from "../lib/resizeSession";

interface TerminalSplitDividerProps {
  /** Pane-A width as a fraction of the container (0..1). */
  ratio: number;
  onRatioChange: (ratio: number) => void;
  /** The relatively-positioned pane container this divider sits inside; used
   *  to convert pointer X into a fraction. */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** Push the live ratio straight onto the elements it positions — the two
   *  pane wrappers and the left tab strip. Supplied by TerminalTabs, which
   *  knows those elements; the divider positions itself. A drag frame is then
   *  a few style writes and no React render.
   *
   *  (Not a custom property on a shared ancestor: those are inherited, so
   *  writing one per frame would invalidate style for both terminals' subtrees
   *  every frame — the cost this is meant to avoid.) */
  onLiveRatio: (ratio: number) => void;
}

// Keep both panes usably wide.
const MIN = 0.2;
const MAX = 0.8;

// A thin vertical handle at the pane-A/pane-B boundary. Container-relative (the
// app's useResizablePane/PaneDivider are viewport-anchored, wrong for an inner
// split), so it measures the container rect once at drag start and clamps the
// ratio from there.
export function TerminalSplitDivider({
  ratio,
  onRatioChange,
  containerRef,
  onLiveRatio,
}: TerminalSplitDividerProps) {
  const [dragging, setDragging] = useState(false);
  const draggingRef = useRef(false);
  const pendingRef = useRef(ratio);
  // Hoisted container geometry — it cannot change mid-drag, and reading it per
  // raw pointer event forced a layout above the frame rate.
  const boundsRef = useRef<{ left: number; width: number } | null>(null);
  // This handle's own element, so it can position itself without a render.
  const selfRef = useRef<HTMLDivElement | null>(null);
  const liveRef = useRef(onLiveRatio);
  liveRef.current = onLiveRatio;
  const apply = useMemo(
    () =>
      rafCoalesce((r: number) => {
        if (selfRef.current) {
          selfRef.current.style.left = `calc(${r * 100}% - 3px)`;
        }
        liveRef.current(r);
      }),
    [],
  );

  // Unmounting mid-drag (the split is toggled off, the dock crashes into its
  // boundary) gets no pointerup, so release the session here or the whole app
  // stays permanently "resizing" — terminals frozen, effects gated.
  useEffect(
    () => () => {
      apply.cancel();
      if (draggingRef.current) {
        draggingRef.current = false;
        endResizeSession();
      }
    },
    [apply],
  );

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const el = containerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.width <= 0) return;
    boundsRef.current = { left: r.left, width: r.width };
    draggingRef.current = true;
    pendingRef.current = ratio;
    setDragging(true);
    beginResizeSession();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!draggingRef.current) return;
    const b = boundsRef.current;
    if (!b) return;
    const next = (e.clientX - b.left) / b.width;
    pendingRef.current = Math.min(MAX, Math.max(MIN, next));
    apply(pendingRef.current);
  };

  const end = () => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    boundsRef.current = null;
    setDragging(false);
    apply.cancel();
    // Land the exact rest position, then make it state — the one React commit
    // of the whole drag.
    if (selfRef.current) {
      selfRef.current.style.left = `calc(${pendingRef.current * 100}% - 3px)`;
    }
    onLiveRatio(pendingRef.current);
    onRatioChange(pendingRef.current);
    endResizeSession();
  };

  return (
    <div
      ref={selfRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      title="Drag to resize panes"
      className="absolute top-0 bottom-0"
      style={{
        // Center the 7px hit area on the boundary. Overwritten directly
        // during a drag so the handle tracks the pointer without a render.
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
