// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import type { CSSProperties } from "react";

/** The one working spinner: a `currentColor` ring with a gap, turned by the
 *  compositor. It is an HTML element on purpose — WebKit's legacy SVG path
 *  lays out and repaints a rotating `<svg>` on the main thread every frame,
 *  which is what kept the renderer and the GPU process hot while nothing on
 *  screen was moving (docs/perf-budget.md "Idle heat"). A surface tones it
 *  with `color`, or `tone` for a stylesheet's `[data-tone]` rule. Decorative:
 *  whoever shows one says the state in words. The ring's rule lives in
 *  styles.css (`.rl-spinner`) and stops under reduced motion. */
export function Spinner({
  size = 12,
  stroke = 1.5,
  className,
  style,
  tone,
}: {
  size?: number;
  stroke?: number;
  className?: string;
  style?: CSSProperties;
  tone?: string;
}) {
  return (
    <span
      aria-hidden
      className={className ? `rl-spinner ${className}` : "rl-spinner"}
      data-tone={tone}
      style={{ width: size, height: size, borderWidth: stroke, ...style }}
    />
  );
}
