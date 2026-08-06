// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useEffect } from "react";
import { REVIEW_KEYMAP, type ShortcutGroup } from "../lib/keymap";

// Generic shortcut cheat-sheet modal (the app's first) plus the review
// pane's keymap. `ShortcutHelp` is reusable — pass any groups; the wrapper
// below feeds it the review bindings from the declarative registry
// (lib/keymap.ts), where every shortcut description lives.

export type { ShortcutGroup };

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

export default function ReviewShortcutHelp({ onClose }: { onClose: () => void }) {
  return <ShortcutHelp title="Code review shortcuts" groups={REVIEW_KEYMAP} onClose={onClose} />;
}
