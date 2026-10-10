// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// The one-line strip a dictation shows while you speak: a waveform from the
// mic's levels and the words heard so far, pinned to the composer they will
// land in. Nothing is written into the field until you let go; the strip is
// the only thing that moves meanwhile, and it can't move anything else — it
// is a fixed overlay in its own root, never in the composer's flow, so the
// composer's layout shifts by 0 px. (The Front Door's old live-transcript line
// sat in the flow and pushed the tools down.)
//
// After the capture it may stay a moment as a notice ("Didn't catch that",
// or words that found no text box, with Copy) and then goes by itself. It
// never takes focus: its one button keeps the caret where it was.
//
// Its host mounts it in a polite live region that is always there (a region
// that appears with its words is not announced).

import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from "react";

import "./DictationStrip.css";

export interface StripState {
  /** `listening`: capturing. `placing`: transcribing after the release.
   *  `notice`: a message that fades. */
  phase: "listening" | "placing" | "notice";
  /** The words heard so far, or the notice. */
  text: string;
  /** The latest levels, 0–1, oldest first. */
  levels: number[];
  /** What the strip sits on (the composer); null: the window's foot. */
  anchor: Element | null;
  /** The quiet second line of what to do ("release to insert"). */
  hint: string;
  /** Words nothing could take, offered for copying. */
  copy?: string;
}

/** How many level bars the waveform draws. */
export const STRIP_BARS = 24;
const HEIGHT = 30;
const GAP = 6;

let state: StripState | null = null;
const listeners = new Set<() => void>();

/** The strip's state, set by the dictation host. */
export const strip = {
  get: (): StripState | null => state,
  set(next: StripState | null): void {
    state = next;
    for (const l of listeners) l();
  },
  update(patch: Partial<StripState>): void {
    if (state) strip.set({ ...state, ...patch });
  },
  subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};

/** A level in dBFS as a bar height: the bottom 60 dB of range, floored so a
 *  silent bar still shows. */
export function levelHeight(dbfs: number): number {
  return Math.min(1, Math.max(0.08, (dbfs + 60) / 54));
}

/** Where the strip goes, in viewport pixels: just above its anchor (or, with
 *  no room there, over the anchor's top edge); at most 420 px wide. */
export function stripBox(anchor: DOMRect | null, viewport: { width: number; height: number }): { left: number; top: number; width: number } {
  if (!anchor) {
    const width = Math.min(420, viewport.width - 16);
    return { left: Math.round((viewport.width - width) / 2), top: viewport.height - HEIGHT - 24, width };
  }
  const width = Math.max(220, Math.min(420, anchor.width));
  const left = Math.min(Math.max(8, anchor.left), Math.max(8, viewport.width - width - 8));
  // A tall anchor (a whole document) is pinned by its visible top.
  const top = Math.max(0, anchor.top);
  const above = top - HEIGHT - GAP;
  return { left, top: above >= 4 ? above : top + 4, width };
}

export function DictationStrip() {
  const s = useSyncExternalStore(strip.subscribe, strip.get, strip.get);
  const anchor = s?.anchor ?? null;
  const [box, setBox] = useState(() => stripBox(null, { width: innerWidth, height: innerHeight }));

  // Follow the anchor while shown: a composer that grows, a pane that scrolls
  // or resizes. One rect read a frame; a write only when it moved.
  const shown = !!s;
  useLayoutEffect(() => {
    if (!shown) return;
    let frame = 0;
    let last = "";
    const place = () => {
      const rect = anchor?.isConnected ? anchor.getBoundingClientRect() : null;
      const next = stripBox(rect, { width: innerWidth, height: innerHeight });
      const key = `${next.left},${next.top},${next.width}`;
      if (key !== last) {
        last = key;
        setBox(next);
      }
      frame = requestAnimationFrame(place);
    };
    place();
    return () => cancelAnimationFrame(frame);
  }, [shown, anchor]);

  // A notice fades by itself.
  useEffect(() => {
    if (s?.phase !== "notice") return;
    const t = setTimeout(() => strip.set(null), s.copy ? 8000 : 2400);
    return () => clearTimeout(t);
  }, [s]);

  if (!s) return null;
  const bars = s.levels.slice(-STRIP_BARS);
  return (
    <div
      className="rl-dictation-strip"
      data-phase={s.phase}
      style={{ left: box.left, top: box.top, width: box.width }}
    >
      <span className="rl-dictation-wave" aria-hidden>
        {Array.from({ length: STRIP_BARS }, (_, i) => {
          const level = bars[i - (STRIP_BARS - bars.length)];
          return <i key={i} style={{ transform: `scaleY(${level ?? 0.08})` }} />;
        })}
      </span>
      <span className="rl-dictation-text">
        <span>{s.text || "Listening…"}</span>
      </span>
      {s.copy ? (
        <button
          type="button"
          className="rl-dictation-copy"
          // Keep the caret where it was.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            void navigator.clipboard?.writeText(s.copy!).catch(() => {});
            strip.set(null);
          }}
        >
          Copy
        </button>
      ) : (
        <span className="rl-dictation-hint">{s.hint}</span>
      )}
    </div>
  );
}
