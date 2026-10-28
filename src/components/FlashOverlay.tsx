// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useEffect, useState } from "react";

interface FlashOverlayProps {
  /** Incrementing counter — each new value re-triggers one pulse. */
  seq: number;
  /** Pulse color (any CSS color; user-configurable). */
  color: string;
}

/** The palette has no red: the pulse is amber (`--color-warning`, the
 *  needs-you colour) unless the reviewer picked a colour of their own. The
 *  old default, a red, stored by every install that never touched the
 *  picker, reads as amber too. */
const LEGACY_DEFAULT = "#e8553d";
export function flashPaint(color: string | null | undefined): string {
  const picked = (color ?? "").trim();
  return !picked || picked.toLowerCase() === LEGACY_DEFAULT ? "var(--color-warning)" : picked;
}

// A full-window amber (or user-colored) pulse fired whenever a plan is
// intercepted. Rendered at the top of the app tree. `pointer-events: none`
// keeps the UI fully interactive during the flash. The animation is keyed by
// `seq` so each intercept remounts the element and replays `redline-flash`
// (defined in styles.css); on animation end we unmount until the next bump.
export function FlashOverlay({ seq, color }: FlashOverlayProps) {
  // Track which seq we are currently showing so a repeat bump replays cleanly.
  const [shown, setShown] = useState(0);

  useEffect(() => {
    if (seq > 0) setShown(seq);
  }, [seq]);

  if (shown === 0 || shown !== seq) return null;

  return (
    <div
      key={seq}
      aria-hidden
      onAnimationEnd={() => setShown(0)}
      style={{
        position: "fixed",
        inset: 0,
        background: flashPaint(color),
        pointerEvents: "none",
        zIndex: 9999,
        opacity: 0,
        animation: "redline-flash 0.9s ease-in-out",
      }}
    />
  );
}
