// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// The Discuss pill sprung open into a caption strip (voiceCaption.ts): a voice
// turn taken with the panel closed — heard, thought about, spoken — in a strip
// at most 420 px wide that grows out of the pill and shrinks back into it.
// One of the pill's states, never a segment: a click anywhere on it is the
// pill's click (the voice panel opens), and it never takes focus. Esc is
// heard by the reply itself (awayReply.ts), which stops.
//
// Motion: a FLIP spring from the pill's box, 420 ms with a gentle overshoot,
// the content fading in 80 ms behind the shell; back into the pill in 220 ms,
// the content gone in its first 100. Transform and opacity only. Reduced
// motion makes each a 120 ms crossfade. A lazy chunk: the pill loads it the
// first time it has a caption to show.

import { MessageSquare } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

import { thinkingCaption } from "../audio/turnState";
import { useVoiceCaption, type VoiceCaption } from "../audio/voiceCaption";
import "./DiscussCaption.css";

/** The widest the caption grows. */
export const CAPTION_MAX = 420;
/** How many level bars its waveform draws. */
const BARS = 16;
const MARGIN = 8;

/** Where the caption sits, in viewport pixels: on the pill's left and bottom
 *  edges, so it grows up and to the right out of it, within the pane. */
export function captionBox(
  pill: { left: number; bottom: number; width: number },
  paneRight: number,
  viewport: { width: number; height: number },
): { left: number; bottom: number; width: number } {
  const left = Math.max(MARGIN, pill.left);
  const room = Math.min(paneRight, viewport.width) - MARGIN - left;
  return { left, bottom: viewport.height - pill.bottom, width: Math.round(Math.max(pill.width, Math.min(CAPTION_MAX, room))) };
}

/** What the caption says, for its line and for a screen reader. */
export function captionLine(c: VoiceCaption, now: number): { text: string; spoken: string } {
  switch (c.phase) {
    case "hearing":
      return { text: c.text || "Listening…", spoken: "Listening" };
    case "thinking":
      return { text: thinkingCaption(c.activity, now - c.since), spoken: "Claude is thinking" };
    case "speaking":
      return { text: c.text, spoken: "Claude is answering" };
    case "done":
      return { text: c.text || "The reply is in the panel", spoken: "The reply is in the panel" };
  }
}

const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export default function DiscussCaption({
  pill,
  voiceKey,
  onOpen,
  onGone,
}: {
  pill: RefObject<HTMLElement | null>;
  /** The pill's conversation; any, when it names none. */
  voiceKey?: string;
  /** The pill's click: open the voice panel. */
  onOpen: () => void;
  /** It has shrunk back into the pill. */
  onGone: () => void;
}) {
  const live = useVoiceCaption();
  const mine = live && (voiceKey === undefined || live.key === voiceKey) ? live : null;
  // What it shrinks back with, once there is nothing left to show.
  const lastRef = useRef<VoiceCaption | null>(mine);
  if (mine) lastRef.current = mine;
  const c = mine ?? lastRef.current;
  const ref = useRef<HTMLButtonElement | null>(null);
  const bodyRef = useRef<HTMLSpanElement | null>(null);
  const [box, setBox] = useState<{ left: number; bottom: number; width: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const onGoneRef = useRef(onGone);
  onGoneRef.current = onGone;

  // Follow the pill: a pane that resizes, a pill that stows. One rect read a
  // frame, a write only when it moved. The pill hides under its caption.
  useLayoutEffect(() => {
    const el = pill.current;
    if (!el) return;
    el.dataset.captioned = "";
    let frame = 0;
    let last = "";
    const place = () => {
      const r = el.getBoundingClientRect();
      const pane = (el.offsetParent ?? el.parentElement)?.getBoundingClientRect();
      const next = captionBox(r, pane?.right ?? innerWidth, { width: innerWidth, height: innerHeight });
      const key = `${next.left},${next.bottom},${next.width}`;
      if (key !== last) {
        last = key;
        setBox(next);
      }
      frame = requestAnimationFrame(place);
    };
    place();
    return () => {
      cancelAnimationFrame(frame);
      delete el.dataset.captioned;
    };
  }, [pill]);

  // Spring out of the pill, once placed.
  const placed = !!box;
  useLayoutEffect(() => {
    const el = ref.current;
    const from = pill.current?.getBoundingClientRect();
    if (!placed || !el?.animate || !from) return;
    if (reduced()) {
      el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120 });
      return;
    }
    const to = el.getBoundingClientRect();
    el.animate(
      [{ transform: `scale(${from.width / to.width}, ${from.height / to.height})` }, { transform: "none" }],
      { duration: 420, easing: "cubic-bezier(0.34, 1.28, 0.64, 1)" },
    );
    bodyRef.current?.animate([{ opacity: 0 }, { opacity: 0, offset: 80 / 420 }, { opacity: 1 }], { duration: 420 });
  }, [placed, pill]);

  // Nothing left to show: back into the pill, then gone.
  const leaving = !mine;
  useEffect(() => {
    if (!leaving) return;
    const el = ref.current;
    const to = pill.current?.getBoundingClientRect();
    if (!el?.animate || !to) {
      onGoneRef.current();
      return;
    }
    let shrink: Animation;
    if (reduced()) shrink = el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, fill: "forwards" });
    else {
      const from = el.getBoundingClientRect();
      bodyRef.current?.animate([{ opacity: 1 }, { opacity: 0, offset: 100 / 220 }, { opacity: 0 }], { duration: 220, fill: "forwards" });
      shrink = el.animate(
        [{ transform: "none" }, { transform: `scale(${to.width / from.width}, ${to.height / from.height})` }],
        { duration: 220, easing: "cubic-bezier(.4, 0, 1, 1)", fill: "forwards" },
      );
    }
    shrink.onfinish = () => onGoneRef.current();
    // A new caption before it was gone: it stays, as it was.
    return () => shrink.cancel();
  }, [leaving, pill]);

  // The thinking line's clock: "Still …" once the wait is long.
  const thinking = c?.phase === "thinking";
  useEffect(() => {
    if (!thinking) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [thinking]);

  if (!c || !box) return null;
  const line = captionLine(c, Math.max(now, c.since));
  const bars = c.levels.slice(-BARS);
  return (
    <button
      ref={ref}
      type="button"
      tabIndex={-1}
      className="rl-discuss-caption"
      data-phase={c.phase}
      aria-label="Discuss — open the voice panel"
      title="Open the voice panel"
      // A press never moves the caret from where it was.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onOpen}
      style={{ left: box.left, bottom: box.bottom, width: box.width }}
    >
      <span ref={bodyRef} className="rl-discuss-caption-body">
        <MessageSquare size={14} strokeWidth={2} aria-hidden className="rl-discuss-caption-icon" />
        {c.phase === "hearing" && (
          <span className="rl-discuss-caption-wave" aria-hidden>
            {Array.from({ length: BARS }, (_, i) => (
              <i key={i} style={{ transform: `scaleY(${bars[i - (BARS - bars.length)] ?? 0.08})` }} />
            ))}
          </span>
        )}
        {c.phase === "thinking" && <span className="rl-discuss-caption-mark" aria-hidden />}
        <span className="rl-discuss-caption-text" aria-hidden>
          <span>{line.text}</span>
        </span>
      </span>
      <span className="sr-only" role="status">
        {line.spoken}
      </span>
    </button>
  );
}
