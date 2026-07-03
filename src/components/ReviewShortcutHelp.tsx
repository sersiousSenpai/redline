// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useEffect } from "react";

// Generic shortcut cheat-sheet modal (the app's first) plus the review
// pane's keymap. `ShortcutHelp` is reusable — pass any groups; the wrapper
// below feeds it the review bindings.

export interface ShortcutGroup {
  title: string;
  items: { keys: string; label: string }[];
}

export function ShortcutHelp({
  title,
  groups,
  onClose,
}: {
  title: string;
  groups: ShortcutGroup[];
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "?") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div
      className="rl-shortcut-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onClose}
    >
      <div className="rl-shortcut-card" onClick={(e) => e.stopPropagation()}>
        <div className="rl-shortcut-head">
          <span>{title}</span>
          <button type="button" className="rl-review-btn rl-review-btn-iconic" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="rl-shortcut-groups">
          {groups.map((g) => (
            <div key={g.title} className="rl-shortcut-group">
              <div className="rl-shortcut-group-title">{g.title}</div>
              {g.items.map((it) => (
                <div key={it.keys} className="rl-shortcut-item">
                  <span className="rl-shortcut-keys">
                    {it.keys.split(" ").map((k) => (
                      <kbd key={k}>{k}</kbd>
                    ))}
                  </span>
                  <span>{it.label}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const REVIEW_GROUPS: ShortcutGroup[] = [
  {
    title: "Files",
    items: [
      { keys: "J", label: "Next file" },
      { keys: "K", label: "Previous file" },
      { keys: "V", label: "Toggle viewed (collapses)" },
      { keys: "X", label: "Collapse / expand file" },
      { keys: "⌘B", label: "Toggle file tree" },
    ],
  },
  {
    title: "Annotations",
    items: [
      { keys: "[", label: "Previous annotation" },
      { keys: "]", label: "Next annotation" },
      { keys: "click", label: "Select a line (row or +)" },
      { keys: "drag", label: "Select a range (gutter or text)" },
      { keys: "⇧click", label: "Extend the selection" },
    ],
  },
  {
    title: "Review",
    items: [
      { keys: "⌘F", label: "Find in diff" },
      { keys: "⌘↩", label: "Submit (while the agent waits)" },
      { keys: "?", label: "This help" },
    ],
  },
];

export default function ReviewShortcutHelp({ onClose }: { onClose: () => void }) {
  return <ShortcutHelp title="Code review shortcuts" groups={REVIEW_GROUPS} onClose={onClose} />;
}
