// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { DIVIDER_W } from "../lib/paneLayout";

/** How far the invisible grab zone reaches past the 1px seam on each side.
 *  It takes no layout width; the seam stays one rule. */
export const SEAM_GRAB_OVERHANG = 4;

interface PaneDividerProps {
  /** The column this seam belongs to is folded. Dragging the seam then pulls
   *  the column back open (the host's resize hook owns that). */
  collapsed: boolean;
  dragging: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
  /** Which edge the host column occupies: "leading" (the sidebar, the seam
   *  on its trailing edge) or "trailing" (the rail, the default). Read only
   *  for the tooltip — a seam has no direction to draw. */
  side?: "leading" | "trailing";
  /** What the column holds, e.g. "sidebar" / "rail" — used in the tooltip. */
  label?: string;
  /** The host column is fullscreen: the seam is not a drag handle. */
  fullscreen?: boolean;
}

// The seam between two columns (D38): one 1px rule in `--color-rule` that is
// also the drag handle. No gutter, no chevron pill — a column folds from ◧/◨
// in the top bar, ⌘B / ⌘⌥B, the palette, or a drag past its minimum, which
// snaps it shut. The grab zone overhangs the rule on both sides without
// taking layout width, so the cursor is easy to acquire beside a scrollbar.
export function PaneDivider({
  collapsed,
  dragging,
  onPointerDown,
  side = "trailing",
  label = "rail",
  fullscreen = false,
}: PaneDividerProps) {
  const title = fullscreen
    ? undefined
    : collapsed
      ? `Drag to show the ${label}`
      : `Drag to resize the ${label}`;
  return (
    <div
      className={["relative shrink-0 rl-divider rl-divider--v", fullscreen ? "rl-divider--static" : ""].filter(Boolean).join(" ")}
      data-seam={side}
      data-dragging={dragging ? "" : undefined}
      style={{ width: `${DIVIDER_W}px` }}
    >
      {/* The rule itself — non-interactive; the grab zone below takes the
          pointer. Accent while dragging (see styles.css). */}
      <div className="rl-divider-bar" />
      <div
        onPointerDown={
          fullscreen
            ? undefined
            : (e) => {
                // Capture the pointer for the whole gesture: a fast drag that
                // outruns the seam (or crosses the native browser webview)
                // keeps tracking, and nothing else can steal it mid-flight.
                // `touchAction: none` stops the OS reading it as a pan.
                try {
                  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                } catch {
                  /* capture unsupported / pointer already gone — drag still
                     works off the window listeners */
                }
                onPointerDown(e);
              }
        }
        className="rl-divider-grab"
        title={title}
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          left: -SEAM_GRAB_OVERHANG,
          right: -SEAM_GRAB_OVERHANG,
          cursor: fullscreen ? "default" : "col-resize",
          touchAction: "none",
        }}
      />
    </div>
  );
}
