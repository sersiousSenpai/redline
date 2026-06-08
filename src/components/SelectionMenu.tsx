// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import type { CommentType } from "../types";

interface SelectionMenuProps {
  rect: DOMRect;
  onPick: (type: CommentType) => void;
  /** Cross out the selection — opens the edit composer pre-set to delete the
   *  span (revised = ""). When omitted, the strike button is hidden. */
  onCrossOut?: () => void;
}

export function SelectionMenu({ rect, onPick, onCrossOut }: SelectionMenuProps) {
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
    </div>
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
