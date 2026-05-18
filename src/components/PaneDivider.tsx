interface PaneDividerProps {
  collapsed: boolean;
  dragging: boolean;
  onToggle: () => void;
  onPointerDown: (e: React.PointerEvent) => void;
}

// Vertical divider between the document column and the comment pane. Hosts the
// drag affordance (when expanded) and a collapse/expand chevron button.
export function PaneDivider({
  collapsed,
  dragging,
  onToggle,
  onPointerDown,
}: PaneDividerProps) {
  return (
    <div
      className="relative shrink-0"
      style={{ width: "6px" }}
    >
      <div
        onPointerDown={collapsed ? undefined : onPointerDown}
        title={collapsed ? undefined : "Drag to resize comments"}
        style={{
          position: "absolute",
          inset: 0,
          cursor: collapsed ? "default" : "col-resize",
          background: dragging
            ? "var(--color-info)"
            : "var(--color-rule)",
          transition: dragging ? undefined : "background-color 0.12s",
        }}
      />
      <button
        type="button"
        onClick={onToggle}
        title={collapsed ? "Show comments" : "Collapse comments"}
        aria-label={collapsed ? "Show comments" : "Collapse comments"}
        className="absolute flex items-center justify-center rounded-full shadow-sm"
        style={{
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: "18px",
          height: "34px",
          fontSize: "11px",
          lineHeight: 1,
          background: "var(--color-bg-elevated)",
          color: "var(--color-ink-muted)",
          border: "1px solid var(--color-rule)",
          cursor: "pointer",
        }}
      >
        {collapsed ? "‹" : "›"}
      </button>
    </div>
  );
}
