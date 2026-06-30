// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useEffect, useRef } from "react";

interface DrafterFindBarProps {
  query: string;
  onQueryChange: (q: string) => void;
  replacement: string;
  onReplacementChange: (r: string) => void;
  matchCount: number;
  /** 0-based index of the active match, or -1 when there are none. */
  activeIndex: number;
  onNext: () => void;
  onPrev: () => void;
  onReplaceOne: () => void;
  onReplaceAll: () => void;
  onClose: () => void;
}

/** The drafter's find-and-replace bar. Presentational — PromptDrafter owns the
 *  query/replacement state and drives the SearchHighlight commands (find) and
 *  the replace transactions. Mirrors Word's find/replace: type to filter, Enter
 *  / Shift+Enter to step matches, Esc to close, plus a replace row. Reuses the
 *  shared `.rl-search-*` styles for the find row. */
export function DrafterFindBar({
  query,
  onQueryChange,
  replacement,
  onReplacementChange,
  matchCount,
  activeIndex,
  onNext,
  onPrev,
  onReplaceOne,
  onReplaceAll,
  onClose,
}: DrafterFindBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus + select on open so a second Cmd+F lets the user overtype the query.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <div
      className="rl-search-box rl-find-col"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="rl-find-row">
        <input
          ref={inputRef}
          type="text"
          value={query}
          placeholder="Find…"
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (e.shiftKey) onPrev();
              else onNext();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
          className="rl-search-input"
        />
        <span className="rl-search-count">
          {matchCount > 0 ? `${activeIndex + 1}/${matchCount}` : "0/0"}
        </span>
        <button
          type="button"
          className="rl-search-btn"
          title="Previous match (Shift+Enter)"
          aria-label="Previous match"
          disabled={matchCount === 0}
          onClick={onPrev}
        >
          ↑
        </button>
        <button
          type="button"
          className="rl-search-btn"
          title="Next match (Enter)"
          aria-label="Next match"
          disabled={matchCount === 0}
          onClick={onNext}
        >
          ↓
        </button>
        <button
          type="button"
          className="rl-search-btn"
          title="Close (Esc)"
          aria-label="Close find"
          onClick={onClose}
        >
          ✕
        </button>
      </div>
      <div className="rl-find-row">
        <input
          type="text"
          value={replacement}
          placeholder="Replace with…"
          onChange={(e) => onReplacementChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onReplaceOne();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
          className="rl-search-input"
        />
        <button
          type="button"
          className="rl-search-btn"
          title="Replace the current match"
          disabled={matchCount === 0}
          onClick={onReplaceOne}
        >
          Replace
        </button>
        <button
          type="button"
          className="rl-search-btn"
          title="Replace every match"
          disabled={matchCount === 0}
          onClick={onReplaceAll}
        >
          All
        </button>
      </div>
    </div>
  );
}
