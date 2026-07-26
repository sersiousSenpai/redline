// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { MessageSquare } from "lucide-react";

// The floating "Discuss" pill — the one entry point to discussion on the
// document and drafter panes. Normally opens the global Companion drawer; on
// a legacy manifest (companion off, voice on) it opens the surface's
// VoicePanel instead so voice stays reachable. Positioned by the host: it
// must sit inside a `relative` pane container (never a scroll container — an
// absolutely positioned child would scroll away with the content).
export function DiscussPill({
  onClick,
  title = "Discuss — one conversation that follows you everywhere (⌘J)",
  bottom = 16,
}: {
  onClick: () => void;
  title?: string;
  /** Distance from the pane's bottom edge, px. */
  bottom?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className="absolute flex items-center gap-1.5 rounded-full"
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
