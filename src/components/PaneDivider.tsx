// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
interface PaneDividerProps {
  collapsed: boolean;
  dragging: boolean;
  onToggle: () => void;
  onPointerDown: (e: React.PointerEvent) => void;
  /** "vertical" = between columns (default), "horizontal" = above a bottom dock. */
  orientation?: "vertical" | "horizontal";
  /** What the pane holds, e.g. "comments" / "terminal" — used in tooltips. */
  label?: string;
}

// Divider hosting a drag affordance (when expanded) and a collapse/expand
// chevron. Used both between the document and comment columns (vertical) and
// above the bottom terminal dock (horizontal).
export function PaneDivider({
  collapsed,
  dragging,
  onToggle,
  onPointerDown,
  orientation = "vertical",
  label = "comments",
}: PaneDividerProps) {
  const horizontal = orientation === "horizontal";
  const resizeCursor = horizontal ? "row-resize" : "col-resize";

  return (
    <div
      className="relative shrink-0"
      style={horizontal ? { height: "6px" } : { width: "6px" }}
    >
      <div
        onPointerDown={collapsed ? undefined : onPointerDown}
        title={collapsed ? undefined : `Drag to resize ${label}`}
        style={{
          position: "absolute",
          inset: 0,
          cursor: collapsed ? "default" : resizeCursor,
          background: dragging ? "var(--color-info)" : "var(--color-rule)",
          transition: dragging ? undefined : "background-color 0.12s",
        }}
      />
      <button
        type="button"
        onClick={onToggle}
        title={collapsed ? `Show ${label}` : `Collapse ${label}`}
        aria-label={collapsed ? `Show ${label}` : `Collapse ${label}`}
        className="absolute flex items-center justify-center rounded-full shadow-sm"
        style={{
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: horizontal ? "34px" : "18px",
          height: horizontal ? "18px" : "34px",
          fontSize: "11px",
          lineHeight: 1,
          background: "var(--color-bg-elevated)",
          color: "var(--color-ink-muted)",
          border: "1px solid var(--color-rule)",
          cursor: "pointer",
        }}
      >
        {horizontal
          ? collapsed
            ? "⌃"
            : "⌄"
          : collapsed
            ? "‹"
            : "›"}
      </button>
    </div>
  );
}
