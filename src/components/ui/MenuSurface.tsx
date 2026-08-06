// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import type { CSSProperties, ReactNode } from "react";

// The popover-card idiom, deduped from the Settings dropdown, the Options
// (download) menu and the header's surface context menu: one elevated rounded
// card floating above the shell. Positioning (absolute/fixed, top/width,
// z-index) stays at the call site via className/style; open/close state and
// the useMenuOverlay webview-hide contract stay with the caller too — this is
// only the surface.
interface MenuSurfaceProps {
  children: ReactNode;
  role?: string;
  ariaLabel?: string;
  className?: string;
  style?: CSSProperties;
  /** e.g. stopPropagation so a click-away closer doesn't eat item clicks. */
  onMouseDown?: (e: React.MouseEvent) => void;
}

export function MenuSurface({
  children,
  role = "menu",
  ariaLabel,
  className,
  style,
  onMouseDown,
}: MenuSurfaceProps) {
  return (
    <div
      role={role}
      aria-label={ariaLabel}
      className={className}
      style={{
        borderRadius: "var(--rl-radius-control)",
        border: "1px solid var(--color-rule)",
        background: "var(--color-bg-elevated)",
        boxShadow: "0 8px 24px rgba(0, 0, 0, 0.28)",
        ...style,
      }}
      onMouseDown={onMouseDown}
    >
      {children}
    </div>
  );
}
