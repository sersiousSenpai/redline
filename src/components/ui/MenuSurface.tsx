// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import type { CSSProperties, ReactNode } from "react";

// The popover-card idiom, deduped from the Settings dropdown, the Options
// (download) menu and the header's surface context menu: one rounded card in
// the glass menu tier, floating above the shell. Positioning (absolute/fixed, top/width,
// z-index) stays at the call site via className/style; open/close state and
// the useMenuOverlay webview-hide contract stay with the caller too — this is
// only the surface.
interface MenuSurfaceProps {
  children: ReactNode;
  role?: string;
  /** A dialog the rest of the app waits behind (`aria-modal`). */
  modal?: boolean;
  ariaLabel?: string;
  className?: string;
  style?: CSSProperties;
  /** e.g. stopPropagation so a click-away closer doesn't eat item clicks. */
  onMouseDown?: (e: React.MouseEvent) => void;
}

export function MenuSurface({
  children,
  role = "menu",
  modal,
  ariaLabel,
  className,
  style,
  onMouseDown,
}: MenuSurfaceProps) {
  return (
    <div
      role={role}
      aria-modal={modal || undefined}
      aria-label={ariaLabel}
      className={`rl-glass rl-glass-menu ${className ?? ""}`}
      style={{
        borderRadius: "var(--rl-radius-control)",
        // The glass menu tier draws the fill, rim and shadow; the border
        // stays 1px so the surface keeps its size.
        border: "1px solid transparent",
        ...style,
      }}
      onMouseDown={onMouseDown}
    >
      {children}
    </div>
  );
}
