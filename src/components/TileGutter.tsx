// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useEffect, useMemo, useRef, useState } from "react";

import { rafCoalesce } from "../lib/raf";
import { beginResizeSession, endResizeSession } from "../lib/resizeSession";
import type { Gutter } from "../lib/tileGrid";

interface TileGutterProps {
  /** The boundary this handle drags, with its band and px-resolved clamps
   *  already computed by `gutters()` — a drag frame is two comparisons and
   *  zero allocation here. */
  gutter: Gutter;
  /** The relatively-positioned pane container the grid tiles; used to convert
   *  pointer position into a container fraction. */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** Push the live position straight onto the tile wrappers (TerminalTabs'
   *  `applyRects` path) — a drag frame is a handful of style writes and no
   *  React render. */
  onLive: (gutter: Gutter, pos: number) => void;
  /** The one React commit of the drag, at rest. */
  onCommit: (gutter: Gutter, pos: number) => void;
  /** Double-click: even out the pair. */
  onEven?: (gutter: Gutter) => void;
}

// One draggable boundary of the tile grid, successor to the old two-pane
// TerminalSplitDivider — everything that divider earned carries over: one
// getBoundingClientRect at pointerdown (per-move reads forced layout above
// frame rate), setPointerCapture, rafCoalesce, the exact rest position written
// to the DOM before the state commit, beginResizeSession/endResizeSession and
// the unmount cleanup that releases a session left open — which matters more
// now, since tiles come and go routinely and a leaked session freezes every
// terminal in the app permanently.
export function TileGutter({
  gutter,
  containerRef,
  onLive,
  onCommit,
  onEven,
}: TileGutterProps) {
  const horizontalDrag = gutter.axis === "x";
  const [dragging, setDragging] = useState(false);
  const draggingRef = useRef(false);
  const pendingRef = useRef(gutter.pos);
  // Hoisted container geometry — it cannot change mid-drag, and reading it per
  // raw pointer event forced a layout above the frame rate.
  const boundsRef = useRef<{ start: number; length: number } | null>(null);
  // This handle's own element, so it can position itself without a render.
  const selfRef = useRef<HTMLDivElement | null>(null);
  const liveRef = useRef(onLive);
  liveRef.current = onLive;
  const gutterRef = useRef(gutter);
  gutterRef.current = gutter;

  const placeSelf = (pos: number) => {
    const el = selfRef.current;
    if (!el) return;
    if (gutterRef.current.axis === "x") {
      el.style.left = `calc(${pos * 100}% - 3px)`;
    } else {
      el.style.top = `calc(${pos * 100}% - 3px)`;
    }
  };

  const apply = useMemo(
    () =>
      rafCoalesce((pos: number) => {
        placeSelf(pos);
        liveRef.current(gutterRef.current, pos);
      }),
    [],
  );

  // Unmounting mid-drag (a tile closed, the shape changed, the dock crashed
  // into its boundary) gets no pointerup, so release the session here or the
  // whole app stays permanently "resizing" — terminals frozen, effects gated.
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

  const clamp = (raw: number) =>
    Math.min(gutterRef.current.max, Math.max(gutterRef.current.min, raw));

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const el = containerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const length = horizontalDrag ? r.width : r.height;
    if (length <= 0) return;
    boundsRef.current = { start: horizontalDrag ? r.left : r.top, length };
    draggingRef.current = true;
    pendingRef.current = gutter.pos;
    setDragging(true);
    beginResizeSession();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!draggingRef.current) return;
    const b = boundsRef.current;
    if (!b) return;
    const raw =
      ((horizontalDrag ? e.clientX : e.clientY) - b.start) / b.length;
    pendingRef.current = clamp(raw);
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
    placeSelf(pendingRef.current);
    liveRef.current(gutterRef.current, pendingRef.current);
    onCommit(gutterRef.current, pendingRef.current);
    endResizeSession();
  };

  // The 7px hit area centered on the boundary, spanning the gutter's band on
  // the cross axis. Row gutters sit ABOVE column gutters (zIndex 11 vs 10) so
  // the 7×7 square at a T-junction resizes the row — the outer structure.
  const style: React.CSSProperties = horizontalDrag
    ? {
        left: `calc(${gutter.pos * 100}% - 3px)`,
        top: `${gutter.crossStart * 100}%`,
        height: `${gutter.crossLength * 100}%`,
        width: "7px",
        cursor: "col-resize",
        zIndex: 10,
      }
    : {
        top: `calc(${gutter.pos * 100}% - 3px)`,
        left: `${gutter.crossStart * 100}%`,
        width: `${gutter.crossLength * 100}%`,
        height: "7px",
        cursor: "row-resize",
        zIndex: 11,
      };

  return (
    <div
      ref={selfRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={onEven ? () => onEven(gutterRef.current) : undefined}
      title="Drag to resize tiles"
      className="absolute"
      style={{ ...style, touchAction: "none", position: "absolute" }}
    >
      {/* The visible 1px rule, brighter while dragging. It also papers over
          any sub-pixel seam between the un-snapped tile edges. */}
      <div
        style={
          horizontalDrag
            ? {
                width: "1px",
                height: "100%",
                margin: "0 auto",
                background: dragging ? "var(--color-info)" : "var(--color-rule)",
              }
            : {
                height: "1px",
                width: "100%",
                margin: "3px 0",
                background: dragging ? "var(--color-info)" : "var(--color-rule)",
              }
        }
      />
    </div>
  );
}
