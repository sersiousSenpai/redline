// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

/** Horizontal nudge (px) applied to the collapse caret so a *collapsed* pane's
 *  pill isn't shaved at the window edge.
 *
 *  The 18px-wide pill is centred on a 6px divider, so it overhangs 6px each
 *  side. That's invisible mid-window, but a collapsed pane's divider sits
 *  against the window edge: the outer overhang is clipped by the row's
 *  overflow-hidden and the inner overhang is painted over by the adjacent
 *  column (a later positioned sibling). Both rounded ends get shaved and the
 *  caret reads as a square. Shifting inward by exactly the overhang lands the
 *  whole pill inside the viewport — a leading pane's divider hugs the left edge
 *  (so shift right), a trailing pane's hugs the right (so shift left).
 *  Horizontal dividers span the full width and never hug an edge, so they are
 *  left alone. */
export function collapsedCaretNudge(
  collapsed: boolean,
  orientation: "vertical" | "horizontal",
  side: "leading" | "trailing",
  overhang = 6,
): number {
  if (!collapsed || orientation === "horizontal") return 0;
  return side === "leading" ? overhang : -overhang;
}

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
  // Horizontal dividers reuse the same "›" chevron, CSS-rotated to point up or
  // down. The dedicated arrowhead codepoints aren't safe here: U+2304 "⌄" is
  // missing from many fonts (unlike its sibling U+2303 "⌃", which doubles as
  // the control-key symbol), so the expanded state rendered as a fallback
  // glyph that didn't read as a caret at all.
  const glyph = horizontal
    ? "›"
    : fullscreen
      ? collapseGlyph
      : collapsed
        ? expandGlyph
        : collapseGlyph;
  // Down (+90°) collapses the bottom dock / exits fullscreen; up (-90°)
  // re-opens a collapsed dock.
  const rotation = horizontal ? (!fullscreen && collapsed ? -90 : 90) : 0;

  // The interactive grab zone extends a few px past the 6px visible bar on each
  // side so the resize cursor is easy to acquire even when a scrollbar gutter
  // sits right next to the divider — without thickening the bar or its layout
  // width. As a real DOM element painted above the document column, it also
  // helps the cursor switch over the adjacent native scrollbar gutter.
  const overhang = 6;
  const collapsedNudge = collapsedCaretNudge(
    collapsed,
    orientation,
    side,
    overhang,
  );
  return (
    <div
      className="relative shrink-0"
      style={horizontal ? { height: "6px" } : { width: "6px" }}
    >
      {/* Visible bar — non-interactive; the grab zone below handles pointers. */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          pointerEvents: "none",
          background: dragging ? "var(--color-info)" : "var(--color-rule)",
          transition: dragging ? undefined : "background-color 0.12s",
        }}
      />
      {/* Widened transparent grab/cursor zone. */}
      <div
        onPointerDown={
          dragDisabled
            ? undefined
            : (e) => {
                // Capture the pointer for the whole gesture: a fast drag that
                // outruns the 6px bar (or crosses the native browser webview)
                // keeps tracking, and nothing else can steal it mid-flight.
                // `touchAction: none` stops the OS reading it as a pan.
                try {
                  (e.currentTarget as HTMLElement).setPointerCapture(
                    e.pointerId,
                  );
                } catch {
                  /* capture unsupported / pointer already gone — drag still
                     works off the window listeners */
                }
                onPointerDown(e);
              }
        }
        title={dragDisabled ? undefined : `Drag to resize ${label}`}
        style={{
          position: "absolute",
          ...(horizontal
            ? { left: 0, right: 0, top: -overhang, bottom: -overhang }
            : { top: 0, bottom: 0, left: -overhang, right: -overhang }),
          cursor: dragDisabled ? "default" : resizeCursor,
          touchAction: "none",
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
          transform: collapsedNudge
            ? `translate(calc(-50% + ${collapsedNudge}px), -50%)`
            : "translate(-50%, -50%)",
          width: horizontal ? "34px" : "18px",
          height: horizontal ? "18px" : "34px",
          fontSize: "11px",
          lineHeight: 1,
          background: "var(--color-bg-elevated)",
          color: "var(--color-ink-muted)",
          border: "1px solid var(--color-rule)",
          cursor: "pointer",
          // Above the adjacent column in every state. The curtain-edge divider
          // wrappers sit at 26, so 27 keeps the caret on top of those too.
          zIndex: 27,
        }}
      >
        <span
          style={{
            display: "inline-block",
            transform: rotation ? `rotate(${rotation}deg)` : undefined,
          }}
        >
          {glyph}
        </span>
      </button>
      )}
    </div>
  );
}
