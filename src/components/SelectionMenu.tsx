// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useState } from "react";
import type { CommentType } from "../types";

interface SelectionMenuProps {
  rect: DOMRect;
  onPick: (type: CommentType) => void;
  /** Cross out the selection — opens the edit composer pre-set to delete the
   *  span (revised = ""). When omitted, the strike button is hidden. */
  onCrossOut?: () => void;
  /** Search the web for the selection. Hands off to `PlanSearchBar` — the
   *  menu itself disappears with the editor selection the moment an input
   *  takes focus, so the bar holds its own copy. */
  onSearch?: () => void;
}

export function SelectionMenu({ rect, onPick, onCrossOut, onSearch }: SelectionMenuProps) {
  const top = Math.max(8, rect.top - 42);
  const left = Math.max(8, rect.left + rect.width / 2 - 110);

  return (
    <div
      className="fixed z-50 flex items-center gap-1 rounded-md shadow-lg border px-1 py-1"
      style={{
        top,
        left,
        background: "var(--color-bg-elevated)",
        borderColor: "var(--color-rule)",
      }}
      onMouseDown={(e) => e.preventDefault()}
    >
      <MenuButton onClick={() => onPick("edit")} colorVar="--color-info">
        Edit
      </MenuButton>
      <MenuButton onClick={() => onPick("feedback")} colorVar="--color-warning">
        Feedback
      </MenuButton>
      <MenuButton onClick={() => onPick("question")} colorVar="--color-success">
        Question
      </MenuButton>
      {onCrossOut && (
        <MenuButton onClick={onCrossOut} colorVar="--color-ink-muted">
          Strike
        </MenuButton>
      )}
      {onSearch && (
        <MenuButton onClick={onSearch} colorVar="--color-ink">
          Search
        </MenuButton>
      )}
    </div>
  );
}

/** Search from the plan: the menu's Search, expanded into one line. The
 *  passage is shown as what will be searched; the input takes an optional
 *  instruction. ⏎ opens a browser tab whose agent researches it; Esc backs
 *  out. */
export function PlanSearchBar({
  rect,
  selectedText,
  onSubmit,
  onCancel,
}: {
  rect: DOMRect;
  selectedText: string;
  onSubmit: (instruction: string) => void;
  onCancel: () => void;
}) {
  const [instruction, setInstruction] = useState("");
  const top = Math.max(8, rect.top - 46);
  const left = Math.max(8, Math.min(rect.left + rect.width / 2 - 200, window.innerWidth - 408));
  const passage = selectedText.replace(/\s+/g, " ").trim();
  return (
    <form
      className="fixed z-50 flex items-center gap-2 rounded-md shadow-lg border px-2 py-1.5"
      style={{ top, left, width: 400, background: "var(--color-bg-elevated)", borderColor: "var(--color-rule)" }}
      aria-label="Search the web for this passage"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(instruction);
      }}
    >
      <span
        title={passage}
        className="shrink-0 truncate"
        style={{ maxWidth: 140, fontSize: "11px", color: "var(--color-ink-muted)" }}
      >
        🔎 “{passage}”
      </span>
      <input
        autoFocus
        value={instruction}
        onChange={(e) => setInstruction(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        placeholder="Search the web — add an instruction (optional)"
        aria-label="Search instruction"
        className="flex-1 min-w-0 bg-transparent outline-none"
        style={{ fontSize: "12px", color: "var(--color-ink)" }}
      />
      <button type="submit" className="hover-elevated px-2 py-0.5 rounded" style={{ fontSize: "12px", fontWeight: 500, color: "var(--color-ink)" }}>
        Search
      </button>
    </form>
  );
}

function MenuButton({
  onClick,
  children,
  colorVar,
}: {
  onClick: () => void;
  children: React.ReactNode;
  colorVar: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="hover-elevated px-2.5 py-1 rounded"
      style={{
        fontSize: "12px",
        color: `var(${colorVar})`,
        fontWeight: 500,
      }}
    >
      {children}
    </button>
  );
}
