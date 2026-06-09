// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
interface PaneDividerProps {
  collapsed: boolean;
  dragging: boolean;
  onToggle: () => void;
  onPointerDown: (e: React.PointerEvent) => void;
  /** "vertical" = between columns (default), "horizontal" = above a bottom dock. */
  orientation?: "vertical" | "horizontal";
  /** Which edge the host pane occupies, for the chevron direction. "trailing"
   *  (default) = pane on the right/bottom (divider on its leading edge).
   *  "leading" = pane on the left (divider on its trailing edge), so the
   *  collapse/expand chevron points the opposite way. */
  side?: "leading" | "trailing";
  /** What the pane holds, e.g. "comments" / "terminal" — used in tooltips. */
  label?: string;
  /** When true, the host pane is in fullscreen mode: the drag affordance is
   *  disabled and the chevron exits fullscreen via `onExitFullscreen` instead
   *  of toggling collapse. This preserves the familiar top-edge caret as the
   *  shrink-back affordance regardless of mode. */
  fullscreen?: boolean;
  onExitFullscreen?: () => void;
  /** Hide the collapse/expand chevron button (keeping the drag bar). Used when
   *  the document is obscured and a combined "latch" replaces the two squished
   *  chevrons. */
  hideChevron?: boolean;
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
  side = "trailing",
  label = "comments",
  fullscreen = false,
  onExitFullscreen,
  hideChevron = false,
}: PaneDividerProps) {
  const horizontal = orientation === "horizontal";
  const resizeCursor = horizontal ? "row-resize" : "col-resize";
  // In fullscreen the divider stops being a drag handle; the chevron exits
  // fullscreen so the user can shrink back from the same top-edge spot they
  // already know. A *collapsed* pane's divider stays draggable, though —
  // dragging it re-opens the pane (the host snaps it to its min width).
  const dragDisabled = fullscreen;
  const exitLabel = horizontal
    ? `Exit fullscreen ${label}`
    : `Exit fullscreen ${label}`;
  const handleClick = fullscreen && onExitFullscreen ? onExitFullscreen : onToggle;
  const buttonTitle = fullscreen
    ? exitLabel
    : collapsed
      ? `Show ${label}`
      : `Collapse ${label}`;
  // Chevrons read as "shrink back inward." For vertical dividers the direction
  // depends on which side the pane is on: a trailing (right) pane points "›"
  // when expanded, a leading (left) pane points "‹".
  const leading = side === "leading";
  const collapseGlyph = leading ? "‹" : "›";
  const expandGlyph = leading ? "›" : "‹";
  const glyph = fullscreen
    ? horizontal
      ? "⌄"
      : collapseGlyph
    : horizontal
      ? collapsed
        ? "⌃"
        : "⌄"
      : collapsed
        ? expandGlyph
        : collapseGlyph;

  return (
    <div
      className="relative shrink-0"
      style={horizontal ? { height: "6px" } : { width: "6px" }}
    >
      <div
        onPointerDown={dragDisabled ? undefined : onPointerDown}
        title={dragDisabled ? undefined : `Drag to resize ${label}`}
        style={{
          position: "absolute",
          inset: 0,
          cursor: dragDisabled ? "default" : resizeCursor,
          background: dragging ? "var(--color-info)" : "var(--color-rule)",
          transition: dragging ? undefined : "background-color 0.12s",
        }}
      />
      {!hideChevron && (
      <button
        type="button"
        onClick={handleClick}
        title={buttonTitle}
        aria-label={buttonTitle}
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
        {glyph}
      </button>
      )}
    </div>
  );
}
