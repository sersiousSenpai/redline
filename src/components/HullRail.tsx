// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import type { ReactNode } from "react";

import type { EdgeReveal } from "../hooks/useEdgeReveal";
import { SHELL_EDGE } from "../lib/paneLayout";
import { beginWindowDrag, toggleWindowMaximize } from "../lib/windowDrag";

// Immersive chrome: the header can't simply vanish. `tauri.conf.json` runs
// `titleBarStyle: "Overlay"` + `hiddenTitle: true`, so there is no native
// title bar — the macOS traffic lights float over the content and the header
// element IS the window-drag region. Removing it would strip dragging and
// drop the lights onto the browser page. So immersive collapses the header to
// a slim hull rail that keeps both jobs (drag region, traffic-light clearance)
// and adds a third: it is the hover target that brings the real header back.
//
// The footer has no such constraint and hides outright, leaving a matching
// SHELL_EDGE strip of hull as its own hover target.

/** Tall enough to clear the macOS traffic lights, so they never paint over
 *  the plate (or the native browser webview inside it). */
const TOP_RAIL_H = 28;

export function HullRail({
  edge,
  onReveal,
}: {
  edge: "top" | "bottom";
  onReveal: () => void;
}) {
  if (edge === "bottom") {
    return (
      <div
        aria-hidden="true"
        className="rl-hull-rail rl-app-footer shrink-0"
        onPointerEnter={onReveal}
        style={{ height: `${SHELL_EDGE}px`, background: "var(--color-bg)" }}
      />
    );
  }
  return (
    <header
      // Same class the real header carries, so the boot choreography treats
      // the rail as the bar it stands in for.
      className="rl-hull-rail rl-app-header shrink-0 pl-20"
      onPointerEnter={onReveal}
      onMouseDown={beginWindowDrag}
      onDoubleClick={toggleWindowMaximize}
      style={{ height: `${TOP_RAIL_H}px`, background: "var(--color-bg)" }}
    />
  );
}

/** Renders the chrome, the rail that stands in for it, or the chrome wrapped
 *  in the pointer handlers that keep it revealed. Children are a lazy React
 *  element either way — the header/footer subtree is never rendered while the
 *  rail is up. */
export function ChromeSlot({
  immersive,
  edge,
  reveal,
  children,
}: {
  immersive: boolean;
  edge: "top" | "bottom";
  reveal: EdgeReveal;
  children: ReactNode;
}) {
  if (!immersive) return <>{children}</>;
  if (!reveal.revealed) {
    return <HullRail edge={edge} onReveal={reveal.onRailEnter} />;
  }
  // Reveal REFLOWS — the plate is pushed down (or up) to meet the bar rather
  // than the bar floating over it. Native webviews composite above all React
  // DOM, so a header overlaying the browser would simply be invisible.
  return (
    <div
      className="shrink-0"
      onPointerEnter={reveal.onChromeEnter}
      onPointerLeave={reveal.onChromeLeave}
    >
      {children}
    </div>
  );
}
