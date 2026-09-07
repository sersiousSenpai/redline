// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import type { ConversationDescriptor } from "../lib/conversationContext";

// The conversation dock's context switcher: which conversation this one column
// is holding right now.
//
// It renders ONLY when the surface offers a genuine choice — with a single
// context there is nothing to switch between, and a tab strip over one tab is
// chrome pretending to be a control. That mirrors the pin's own law
// (`activeConversation`): a pin breaks ties, and where there is no tie there is
// nothing to break.
//
// Deliberately not a header: the panel below has its own, and this sits above
// it as a strip the way the terminal dock's tabs sit above a terminal.
export function DockContextStrip({
  contexts,
  activeKey,
  onSelect,
}: {
  contexts: ConversationDescriptor[];
  activeKey: string | null;
  onSelect: (d: ConversationDescriptor) => void;
}) {
  if (contexts.length < 2) return null;
  return (
    <div
      role="tablist"
      aria-label="Conversation"
      className="rl-thin-scroll-x shrink-0 flex items-stretch"
      style={{
        gap: "2px",
        padding: "3px 4px",
        overflowX: "auto",
        borderBottom: "1px solid var(--color-rule)",
        background: "var(--color-bg-elevated)",
      }}
    >
      {contexts.map((d) => {
        const active = d.key === activeKey;
        return (
          <button
            key={d.key}
            type="button"
            role="tab"
            aria-selected={active}
            title={d.label}
            onClick={() => onSelect(d)}
            className="rounded-full whitespace-nowrap"
            style={{
              padding: "3px 9px",
              fontSize: "11px",
              lineHeight: 1.3,
              // The active tab is the only one that carries a surface: an
              // unselected tab is a word, not a button, so the strip reads as
              // one control rather than a row of competing chips.
              background: active ? "var(--color-selection)" : "transparent",
              color: active ? "var(--color-ink)" : "var(--color-ink-muted)",
              border: "none",
              cursor: "pointer",
              maxWidth: "140px",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {d.label}
          </button>
        );
      })}
    </div>
  );
}
