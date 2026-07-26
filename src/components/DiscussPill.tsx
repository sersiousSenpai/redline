// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { MessageSquare, Mic } from "lucide-react";

// The floating "Discuss" pill on the document and drafter panes. The main
// segment opens the global Companion drawer; when `onVoice` is provided a
// second 🎙 segment opens the surface's VoicePanel DIRECTLY — the voice agent
// is a first-class entry, one click, never buried behind the drawer. On a
// legacy manifest (companion off, voice on) the host wires the main segment
// straight to voice instead. Positioned by the host: it must sit inside a
// `relative` pane container (never a scroll container — an absolutely
// positioned child would scroll away with the content).
export function DiscussPill({
  onClick,
  onVoice = null,
  title = "Discuss — one conversation that follows you everywhere (⌘J)",
  voiceTitle = "Discuss by voice",
  bottom = 16,
}: {
  onClick: () => void;
  /** Direct one-click voice entry; null hides the mic segment. */
  onVoice?: (() => void) | null;
  title?: string;
  voiceTitle?: string;
  /** Distance from the pane's bottom edge, px. */
  bottom?: number;
}) {
  const segment: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    border: "none",
    background: "transparent",
    color: "var(--color-ink)",
    fontSize: "13px",
    cursor: "pointer",
    padding: "6px 12px",
  };
  return (
    <div
      className="absolute flex items-stretch rounded-full overflow-hidden"
      style={{
        left: "16px",
        bottom: `${bottom}px`,
        background: "var(--color-bg-elevated)",
        border: "1px solid var(--color-rule)",
        boxShadow: "0 4px 14px rgba(0,0,0,0.18)",
        zIndex: 20,
      }}
    >
      <button
        type="button"
        onClick={onClick}
        title={title}
        aria-label={title}
        style={onVoice ? { ...segment, paddingRight: "10px" } : segment}
      >
        <MessageSquare size={14} strokeWidth={2} />
        Discuss
      </button>
      {onVoice && (
        <>
          <span
            aria-hidden
            style={{
              width: "1px",
              background: "var(--color-rule)",
              margin: "5px 0",
            }}
          />
          <button
            type="button"
            onClick={onVoice}
            title={voiceTitle}
            aria-label={voiceTitle}
            style={{ ...segment, padding: "6px 10px" }}
          >
            <Mic size={14} strokeWidth={2} />
          </button>
        </>
      )}
    </div>
  );
}
