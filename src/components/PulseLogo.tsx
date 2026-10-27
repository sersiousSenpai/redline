// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// The conversation-mode pulse: the Redline mark whose black strike-line spins
// to track the fork's state — still when idle, a slow receptive spin while
// listening, a steady working spin while thinking or streaming. Animation is
// CSS-keyframe driven (see `.rl-pulse-blades` in styles.css) and honors
// `prefers-reduced-motion`. The strike-line is an HTML bar laid over a static
// svg blob, so the spin is the compositor's alone: a transform on an element
// INSIDE an svg is repainted by WebKit's legacy SVG engine on every frame,
// which kept the renderer and the GPU process busy whenever anything said
// "thinking".

/** The red rounded-square blob of the Redline mark (verbatim from `icon.svg`). */
const BLOB =
  "M922 512l-.06 95.49-.16 30.49-.29 22.15-.39 18.01-.51 15.44-.62 13.64-.73 12.29-.85 11.23-.96 10.38-1.08 9.65-1.19 9.04-1.31 8.51-1.42 8.03-1.55 7.62-1.66 7.23-1.78 6.89-1.91 6.58-2.03 6.28-2.15 6.01-2.27 5.76-2.41 5.52-2.53 5.29-2.67 5.08-2.79 4.88-2.94 4.68-3.07 4.5-3.22 4.32-3.36 4.14-3.5 3.98-3.66 3.82-3.82 3.66-3.98 3.5-4.14 3.36-4.32 3.22-4.5 3.07-4.68 2.94-4.88 2.79-5.08 2.67-5.29 2.53-5.52 2.41-5.76 2.27-6.01 2.15-6.28 2.03-6.58 1.91-6.89 1.78-7.23 1.66-7.62 1.55-8.03 1.42-8.51 1.31-9.04 1.19-9.65 1.08-10.38.96-11.23.85-12.29.73-13.64.62-15.44.51-18.01.39-22.15.29-30.49.16-95.49.06-95.49-.06-30.49-.16-22.15-.29-18.01-.39-15.44-.51-13.64-.62-12.29-.73-11.23-.85-10.38-.96-9.65-1.08-9.04-1.19-8.51-1.31-8.03-1.42-7.62-1.55-7.23-1.66-6.89-1.78-6.58-1.91-6.28-2.03-6.01-2.15-5.76-2.27-5.52-2.41-5.29-2.53-5.08-2.67-4.88-2.79-4.68-2.94-4.5-3.07-4.32-3.22-4.14-3.36-3.98-3.5-3.82-3.66-3.66-3.82-3.5-3.98-3.36-4.14-3.22-4.32-3.07-4.5-2.94-4.68-2.79-4.88-2.67-5.08-2.53-5.29-2.41-5.52-2.27-5.76-2.15-6.01-2.03-6.28-1.91-6.58-1.78-6.89-1.66-7.23-1.55-7.62-1.42-8.03-1.31-8.51-1.19-9.04-1.08-9.65-.96-10.38-.85-11.23-.73-12.29-.62-13.64-.51-15.44-.39-18.01-.29-22.15-.16-30.49-.06-95.49.06-95.49.16-30.49.29-22.15.39-18.01.51-15.44.62-13.64.73-12.29.85-11.23.96-10.38 1.08-9.65 1.19-9.04 1.31-8.51 1.42-8.03 1.55-7.62 1.66-7.23 1.78-6.89 1.91-6.58 2.03-6.28 2.15-6.01 2.27-5.76 2.41-5.52 2.53-5.29 2.67-5.08 2.79-4.88 2.94-4.68 3.07-4.5 3.22-4.32 3.36-4.14 3.5-3.98 3.66-3.82 3.82-3.66 3.98-3.5 4.14-3.36 4.32-3.22 4.5-3.07 4.68-2.94 4.88-2.79 5.08-2.67 5.29-2.53 5.52-2.41 5.76-2.27 6.01-2.15 6.28-2.03 6.58-1.91 6.89-1.78 7.23-1.66 7.62-1.55 8.03-1.42 8.51-1.31 9.04-1.19 9.65-1.08 10.38-.96 11.23-.85 12.29-.73 13.64-.62 15.44-.51 18.01-.39 22.15-.29 30.49-.16 95.49-.06 95.49.06 30.49.16 22.15.29 18.01.39 15.44.51 13.64.62 12.29.73 11.23.85 10.38.96 9.65 1.08 9.04 1.19 8.51 1.31 8.03 1.42 7.62 1.55 7.23 1.66 6.89 1.78 6.58 1.91 6.28 2.03 6.01 2.15 5.76 2.27 5.52 2.41 5.29 2.53 5.08 2.67 4.88 2.79 4.68 2.94 4.5 3.07 4.32 3.22 4.14 3.36 3.98 3.5 3.82 3.66 3.66 3.82 3.5 3.98 3.36 4.14 3.22 4.32 3.07 4.5 2.94 4.68 2.79 4.88 2.67 5.08 2.53 5.29 2.41 5.52 2.27 5.76 2.15 6.01 2.03 6.28 1.91 6.58 1.78 6.89 1.66 7.23 1.55 7.62 1.42 8.03 1.31 8.51 1.19 9.04 1.08 9.65.96 10.38.85 11.23.73 12.29.62 13.64.51 15.44.39 18.01.29 22.15.16 30.49z";

export type PulseState = "idle" | "listening" | "thinking" | "streaming";

/** The animated Redline mark. `state` drives the spin (idle → still,
 *  listening → slow spin, thinking/streaming → steady working spin). The
 *  strike-line is drawn in CSS at `icon.svg`'s own geometry — the stroke from
 *  (355,355) to (669,669), 82 wide, in a 1024 box — so the resting mark
 *  matches the app icon. Sized in px; defaults to a small inline indicator. */
export function PulseLogo({
  state,
  size = 18,
  title,
  decorative = false,
}: {
  state: PulseState;
  size?: number;
  title?: string;
  /** Beside a visible label that already says it: hidden from assistive
   *  technology, with no name of its own. */
  decorative?: boolean;
}) {
  const label =
    title ??
    (state === "listening"
      ? "Listening"
      : state === "thinking"
        ? "Claude is thinking"
        : state === "streaming"
          ? "Claude is replying"
          : "Conversation mode");
  return (
    <span
      className="rl-pulse"
      data-state={state}
      {...(decorative ? { "aria-hidden": true } : { role: "img", "aria-label": label })}
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} viewBox="0 0 1024 1024" aria-hidden style={{ display: "block", overflow: "visible" }}>
        <path d={BLOB} fill="#E5342B" />
      </svg>
      <span className="rl-pulse-blades" data-state={state} />
    </span>
  );
}
