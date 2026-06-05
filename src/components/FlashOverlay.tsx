// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useEffect, useState } from "react";

interface FlashOverlayProps {
  /** Incrementing counter — each new value re-triggers one pulse. */
  seq: number;
  /** Pulse color (any CSS color; user-configurable). */
  color: string;
}

// A full-window red (or user-colored) pulse fired whenever a plan is
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
        background: color,
        pointerEvents: "none",
        zIndex: 9999,
        opacity: 0,
        animation: "redline-flash 0.9s ease-in-out",
      }}
    />
  );
}
