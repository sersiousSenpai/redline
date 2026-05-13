import type { CommentType } from "../types";

interface SelectionMenuProps {
  rect: DOMRect;
  onPick: (type: CommentType) => void;
}

export function SelectionMenu({ rect, onPick }: SelectionMenuProps) {
  const top = Math.max(8, rect.top - 42);
  const left = Math.max(8, rect.left + rect.width / 2 - 110);

  return (
    <div
      className="fixed z-50 font-sans flex items-center gap-1 rounded-md shadow-lg border px-1 py-1"
      style={{
        top,
        left,
        background: "white",
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
      className="px-2.5 py-1 rounded hover:bg-stone-100 transition-colors"
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
