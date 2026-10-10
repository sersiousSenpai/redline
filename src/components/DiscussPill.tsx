// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { MessageSquare } from "lucide-react";
import { useEffect, useRef } from "react";

import { useTextClearance } from "../hooks/useTextClearance";
import { setVoiceAway, useVoiceAway } from "../audio/voiceAway";

// The floating "Discuss" pill on the document and drafter panes. One compact
// button, one destination: the voice panel — the app's discussion surface
// (voice-first, with a typed composer inside). Positioned by the host: it
// must sit inside a `relative` pane container (never a scroll container — an
// absolutely positioned child would scroll away with the content).
//
// Hand it `textRef` and the pill also gets out of the way, down a three-stage
// ladder as the pane narrows: the flat pill, then a 90°-hinged vertical tab
// (~110px of gutter given back for ~30px), then a bare icon circle hugging the
// pane edge — so even a 28px gutter keeps it off the text. Each stage climbs
// back up with the same anti-flap hysteresis. Without `textRef` it just sits
// flat, as it always did.
//
// It also carries the state of a voice turn left running when the panel
// closed (`voiceAway`): a breathing mark while the agent works, a dot once its
// reply is waiting. States, never segments — one click still opens the panel.

/** The flat/stowed poses' left offset (also in .rl-discuss-pill CSS). */
const FULL_LEFT = 16;
/** The icon pose: a 26px circle at left 6px (see styles.css) — right edge
 *  ~32px, small enough to stand on a 40px desk gutter. */
const ICON_LEFT = 6;
const ICON_SIZE = 26;

export function DiscussPill({
  onClick,
  title = "Discuss — talk or type with your agent",
  bottom = 16,
  textRef,
  textInset = 0,
  measureKey,
}: {
  onClick: () => void;
  title?: string;
  /** Distance from the pane's bottom edge, px. */
  bottom?: number;
  /** The text column to stay clear of. Omit to never stow. */
  textRef?: React.RefObject<HTMLElement | null>;
  /** That column's left padding, px — where its text actually starts, as
   *  opposed to where its box does. 0 = clear the column's box itself (the
   *  drafter passes its page SHEET: the sheet is the document there). */
  textInset?: number;
  /** Any value that changes when the text column moves WITHOUT the pane
   *  resizing — the wide-view toggle being the case in hand. The clearance
   *  observers watch the scroller, which doesn't move on such a change, so
   *  without this the pill would hold its old pose until something else
   *  happened to resize the pane. */
  measureKey?: unknown;
}) {
  const pillRef = useRef<HTMLButtonElement | null>(null);
  const away = useVoiceAway();
  const awayKey = away?.state === "thinking" ? away.key : null;

  // A turn still running: its end — whenever it lands — means a reply is
  // waiting. One that ended while the pill was off screen is caught by asking.
  useEffect(() => {
    if (!awayKey) return;
    let alive = true;
    const ended = () => {
      if (alive) setVoiceAway({ key: awayKey, state: "waiting" });
    };
    // A failure persists nothing to come back to, so it clears the mark.
    const gone = () => {
      if (alive) setVoiceAway(null);
    };
    const subs = [
      listen<{ sessionId: string }>("voice-done", (e) => e.payload.sessionId === awayKey && ended()),
      listen<{ sessionId: string; text: string }>(
        "voice-interrupted",
        (e) => e.payload.sessionId === awayKey && (e.payload.text ? ended() : gone()),
      ),
      listen<{ sessionId: string }>("voice-error", (e) => e.payload.sessionId === awayKey && gone()),
      listen<{ sessionId: string }>("voice-exit", (e) => e.payload.sessionId === awayKey && gone()),
    ];
    void invoke<{ inFlight: boolean }>("voice_session_status", { sessionId: awayKey })
      .then((s) => {
        if (!s.inFlight) ended();
      })
      .catch(() => {});
    return () => {
      alive = false;
      for (const p of subs) void p.then((un) => un());
    };
  }, [awayKey]);

  const label =
    away?.state === "waiting"
      ? `${title} · a reply is waiting`
      : away?.state === "thinking"
        ? `${title} · Claude is working on a reply`
        : title;

  useTextClearance({
    ctrlRef: pillRef,
    textRef,
    textInset,
    flag: "rlStowed",
    deps: [measureKey],
    // Each stage's right edge, from styling constants + the EXPANDED metrics —
    // never live layout of a collapsed pose (that would feed the collapse back
    // in). Stowed is the rotated footprint: as wide as the pill is tall.
    stages: (w, h) => ({
      full: FULL_LEFT + w,
      stowed: FULL_LEFT + h,
      icon: ICON_LEFT + ICON_SIZE,
    }),
    // The hinge pivot, which only a measured pill can know. Rotating about the
    // bottom-left corner would swing the body down out of the pane, so the
    // obvious fix is to compose in a translate that walks it back — but a
    // rotate+translate sweeps the pill 15px past the pane's left edge and 15px
    // below its bottom mid-swing, where `contain: paint` shears the corner off.
    // This pivot is the one that carries the flat pill onto the standing one by
    // rotation ALONE: a rigid hinge, whose worst excursion is ~2px. Derived by
    // solving R(0,0) + O = the standing box's top-right corner.
    onMeasure: (el, w, h) => {
      const origin = `${w / 2}px ${h - w / 2}px`;
      if (el.style.transformOrigin !== origin) el.style.transformOrigin = origin;
    },
  });

  return (
    <button
      ref={pillRef}
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="rl-discuss-pill absolute flex items-center gap-1.5 rounded-full"
      /* `left` lives in the stylesheet — the icon stage moves it, and an
         inline value would out-specific the stage rule. */
      style={{
        bottom: `${bottom}px`,
        padding: "6px 12px",
        fontSize: "13px",
        background: "var(--color-bg-elevated)",
        border: "1px solid var(--color-rule)",
        color: "var(--color-ink)",
        boxShadow: "0 4px 14px rgba(0,0,0,0.18)",
        cursor: "pointer",
        zIndex: 20,
      }}
    >
      <MessageSquare size={14} strokeWidth={2} />
      <span className="rl-discuss-label">Discuss</span>
      {away && <span className="rl-discuss-badge" data-state={away.state} aria-hidden />}
    </button>
  );
}
