// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { MessageSquare } from "lucide-react";
import { useRef } from "react";

import { useTextClearance } from "../hooks/useTextClearance";

// The floating "Discuss" pill on the document and drafter panes. One compact
// button, one destination: the voice panel — the app's discussion surface
// (voice-first, with a typed composer inside). Positioned by the host: it
// must sit inside a `relative` pane container (never a scroll container — an
// absolutely positioned child would scroll away with the content).
//
// Hand it `textRef` and the pill also gets out of the way: when the pane
// narrows far enough that the text column would run under it, it hinges 90°
// and stands up as a thin vertical tab (~110px of gutter given back for ~30px),
// swinging back down when there's room again. Without `textRef` it just sits
// flat, as it always did.
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
   *  opposed to where its box does. */
  textInset?: number;
  /** Any value that changes when the text column moves WITHOUT the pane
   *  resizing — the wide-view toggle being the case in hand. The clearance
   *  observers watch the scroller, which doesn't move on such a change, so
   *  without this the pill would hold its old pose until something else
   *  happened to resize the pane. */
  measureKey?: unknown;
}) {
  const pillRef = useRef<HTMLButtonElement | null>(null);

  useTextClearance({
    ctrlRef: pillRef,
    textRef,
    textInset,
    flag: "rlStowed",
    deps: [measureKey],
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
      title={title}
      aria-label={title}
      className="rl-discuss-pill absolute flex items-center gap-1.5 rounded-full"
      style={{
        left: "16px",
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
      Discuss
    </button>
  );
}
