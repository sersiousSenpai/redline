// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import type { CSSProperties, ReactNode } from "react";

// Small non-interactive status chip (the header's v-badge, count markers):
// anchor tones on the control radius, so badges match the buttons they sit
// beside instead of inventing their own corner geometry.
interface PillProps {
  children: ReactNode;
  /** anchor: the quiet badge surface. accent: info-filled emphasis. */
  tone?: "anchor" | "accent";
  /** Monospace face (version numbers, counts). */
  mono?: boolean;
  title?: string;
  style?: CSSProperties;
}

export function Pill({
  children,
  tone = "anchor",
  mono = false,
  title,
  style,
}: PillProps) {
  return (
    <span
      title={title}
      className={`px-2 py-0.5 ${mono ? "font-mono" : "font-sans"}`}
      style={{
        borderRadius: "var(--rl-radius-control)",
        fontSize: "var(--rl-text-xs)",
        background:
          tone === "accent" ? "var(--color-info)" : "var(--color-anchor-bg)",
        color:
          tone === "accent"
            ? "var(--color-on-accent)"
            : "var(--color-anchor-text)",
        ...style,
      }}
    >
      {children}
    </span>
  );
}
