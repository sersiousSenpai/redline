// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useEffect, useRef } from "react";

interface PlanSearchBoxProps {
  query: string;
  onQueryChange: (q: string) => void;
  matchCount: number;
  /** 0-based index of the active match, or -1 when there are none. */
  activeIndex: number;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
}

/** The floating find bar for the plan editor. Presentational — PlanEditor owns
 *  the query state and drives the SearchHighlight commands. Mirrors a browser's
 *  in-page find: type to filter, Enter / Shift+Enter to step matches, Esc to
 *  close. */
export function PlanSearchBox({
  query,
  onQueryChange,
  matchCount,
  activeIndex,
  onNext,
  onPrev,
  onClose,
}: PlanSearchBoxProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus + select on open so a second Cmd+F (which re-mounts/re-focuses) lets
  // the user immediately overtype the prior query.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <div
      className="rl-search-box"
      // Keep clicks/selection inside the bar from bubbling to the editor's
      // selection handling.
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <input
        ref={inputRef}
        type="text"
        value={query}
        placeholder="Find in plan…"
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
  );
}
