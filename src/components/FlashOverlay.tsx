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
 *  needs-you colour). A colour the reviewer picked paints it only when it
 *  is not a red: the old default (#e8553d), stored by every install that
 *  never touched the picker, and any red picked since — the last walk's
 *  window flashed RGB 53,26,29, a stored #ff2600 at the pulse's opacity —
 *  read as amber too. */
export function flashPaint(color: string | null | undefined): string {
  const picked = (color ?? "").trim();
  return !picked || isRedHue(picked) ? "var(--color-warning)" : picked;
}

/** The hue of a #rgb / #rrggbb / rgb() colour in degrees, with its
 *  saturation (0–1); null for anything else (a token, a name). */
export function hueOf(color: string): { hue: number; saturation: number } | null {
  let r: number, g: number, b: number;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(color.trim());
  const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(color.trim());
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].split("").map((c) => c + c).join("") : hex[1];
    [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  } else if (rgb) {
    [r, g, b] = [rgb[1], rgb[2], rgb[3]].map(Number);
  } else return null;
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn), d = max - min;
  const l = (max + min) / 2;
  const saturation = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let hue = 0;
  if (d !== 0) {
    if (max === rn) hue = 60 * (((gn - bn) / d) % 6);
    else if (max === gn) hue = 60 * ((bn - rn) / d + 2);
    else hue = 60 * ((rn - gn) / d + 4);
  }
  return { hue: (hue + 360) % 360, saturation };
}

/** Red through red-orange and into the pinks: never a Redline pulse. */
export function isRedHue(color: string): boolean {
  const c = color.trim().toLowerCase();
  if (c === "red" || c === "crimson" || c === "tomato" || c === "orangered") return true;
  const hs = hueOf(c);
  return !!hs && hs.saturation > 0.2 && (hs.hue < 30 || hs.hue > 330);
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
