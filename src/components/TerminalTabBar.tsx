import { useRef, useState } from "react";

interface Tab {
  id: string;
  title: string;
}

interface TerminalTabBarProps {
  tabs: Tab[];
  activeId: string;
  fullscreen: boolean;
  onSelect: (id: string) => void;
  /** New terminal in $HOME ("root"). */
  onNew: () => void;
  /** New terminal in the active terminal's live working directory. */
  onNewHere: () => void;
  onClose: (id: string) => void;
  onToggleFullscreen: () => void;
  /** Commit a reorder: remove the tab at `from`, reinsert it at `to`. */
  onReorder: (from: number, to: number) => void;
}

interface DragState {
  id: string;
  originIndex: number;
  pointerStartX: number;
  /** Measured tab widths in original order, captured at drag start. */
  widths: number[];
  /** Measured tab left offsets (within the bar) in original order. */
  lefts: number[];
}

// Past this many px of movement a press becomes a drag (so a quick click still
// just selects the tab).
const DRAG_THRESHOLD = 4;

// The tab strip atop the terminal dock. Tabs reorder via *pointer* dragging
// (not HTML5 DnD — Tauri's webview hijacks native drag for OS file drops): the
// dragged tab follows the pointer while the others slide to make room, then
// the new order commits on release.
export function TerminalTabBar({
  tabs,
  activeId,
  fullscreen,
  onSelect,
  onNew,
  onNewHere,
  onClose,
  onToggleFullscreen,
  onReorder,
}: TerminalTabBarProps) {
  const dragRef = useRef<DragState | null>(null);
  const tabEls = useRef<Map<string, HTMLDivElement>>(new Map());
  const barRef = useRef<HTMLDivElement | null>(null);
  // dx = live pointer delta; target = index the dragged tab would land at.
  // null id = no drag in progress.
  const [drag, setDrag] = useState<{
    id: string | null;
    dx: number;
    target: number;
    started: boolean;
  }>({ id: null, dx: 0, target: -1, started: false });

  const onPointerDown = (e: React.PointerEvent, id: string, index: number) => {
    // Left button only; the × close button opts out via data-noDrag.
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("[data-no-drag]")) return;

    const bar = barRef.current;
    if (!bar) return;
    const barLeft = bar.getBoundingClientRect().left;
    const widths: number[] = [];
    const lefts: number[] = [];
    for (const t of tabs) {
      const el = tabEls.current.get(t.id);
      const r = el?.getBoundingClientRect();
      widths.push(r?.width ?? 0);
      lefts.push(r ? r.left - barLeft : 0);
    }

    dragRef.current = {
      id,
      originIndex: index,
      pointerStartX: e.clientX,
      widths,
      lefts,
    };
    setDrag({ id, dx: 0, target: index, started: false });
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.pointerStartX;
    const started =
      drag.started || Math.abs(dx) > DRAG_THRESHOLD;
    if (!started) return;

    // Center of the dragged tab in its travel, in bar-local coords.
    const draggedCenter =
      d.lefts[d.originIndex] + d.widths[d.originIndex] / 2 + dx;

    let target = d.originIndex;
    for (let i = 0; i < tabs.length; i++) {
      if (i === d.originIndex) continue;
      const mid = d.lefts[i] + d.widths[i] / 2;
      if (i > d.originIndex && draggedCenter > mid) target = Math.max(target, i);
      if (i < d.originIndex && draggedCenter < mid) target = Math.min(target, i);
    }

    setDrag({ id: d.id, dx, target, started: true });
  };

  const endDrag = () => {
    const d = dragRef.current;
    if (d && drag.started && drag.target !== d.originIndex) {
      onReorder(d.originIndex, drag.target);
    }
    dragRef.current = null;
    setDrag({ id: null, dx: 0, target: -1, started: false });
  };

  const draggedWidth =
    dragRef.current && drag.id
      ? dragRef.current.widths[dragRef.current.originIndex]
      : 0;

  return (
    <div
      ref={barRef}
      className="flex items-stretch shrink-0"
      style={{
        height: "30px",
        borderBottom: "1px solid var(--color-rule)",
        background: "var(--color-bg-elevated)",
      }}
    >
      {tabs.map((t, i) => {
        const active = t.id === activeId;
        const isDragged = drag.started && t.id === drag.id;
        const d = dragRef.current;

        // While a drag is active, non-dragged tabs slide by one dragged-width
        // toward the gap to open a slot at `target`.
        let shift = 0;
        if (d && drag.started && !isDragged) {
          const oi = d.originIndex;
          const tg = drag.target;
          if (oi < tg && i > oi && i <= tg) shift = -draggedWidth;
          else if (oi > tg && i >= tg && i < oi) shift = draggedWidth;
        }

        return (
          <div
            key={t.id}
            ref={(el) => {
              if (el) tabEls.current.set(t.id, el);
              else tabEls.current.delete(t.id);
            }}
            onPointerDown={(e) => onPointerDown(e, t.id, i)}
            onPointerMove={onPointerMove}
            onPointerUp={(e) => {
              const wasDrag = drag.started;
              endDrag();
              if (!wasDrag) onSelect(t.id);
              else e.stopPropagation();
            }}
            onPointerCancel={endDrag}
            title={t.title}
            className="flex items-center gap-1 px-3 cursor-pointer select-none"
            style={{
              color: active
                ? "var(--color-ink)"
                : "var(--color-ink-muted)",
              background: active ? "var(--color-paper)" : "transparent",
              borderBottom: active
                ? "2px solid var(--color-info)"
                : "2px solid transparent",
              fontSize: "12px",
              touchAction: "none",
              transform: isDragged
                ? `translateX(${drag.dx}px)`
                : `translateX(${shift}px)`,
              transition: isDragged
                ? "none"
                : "transform 160ms cubic-bezier(0.2, 0, 0, 1)",
              zIndex: isDragged ? 20 : 0,
              position: "relative",
              opacity: isDragged ? 0.85 : 1,
              boxShadow: isDragged
                ? "0 2px 8px rgba(0,0,0,0.25)"
                : undefined,
            }}
          >
            <span
              className="truncate"
              style={{ maxWidth: "140px" }}
            >
              {t.title}
            </span>
            <button
              type="button"
              data-no-drag
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onClose(t.id);
              }}
              title="Close terminal"
              aria-label="Close terminal"
              className="flex items-center justify-center rounded"
              style={{
                width: "16px",
                height: "16px",
                fontSize: "12px",
                lineHeight: 1,
                color: "var(--color-ink-muted)",
                cursor: "pointer",
              }}
            >
              ×
            </button>
          </div>
        );
      })}
      <div className="flex items-center gap-1 px-2" style={{ marginLeft: "auto" }}>
        <button
          type="button"
          onClick={onNew}
          title="New terminal (home directory)"
          aria-label="New terminal in home directory"
          className="flex items-center justify-center rounded"
          style={{
            width: "20px",
            height: "20px",
            fontSize: "13px",
            lineHeight: 1,
            background: "var(--color-bg-elevated)",
            border: "1px solid var(--color-rule)",
            color: "var(--color-ink-muted)",
            cursor: "pointer",
          }}
        >
          +
        </button>
        <button
          type="button"
          onClick={onNewHere}
          title="New terminal in active terminal's directory"
          aria-label="New terminal in active terminal's directory"
          className="flex items-center justify-center rounded"
          style={{
            width: "20px",
            height: "20px",
            fontSize: "12px",
            lineHeight: 1,
            background: "var(--color-bg-elevated)",
            border: "1px solid var(--color-rule)",
            color: "var(--color-ink-muted)",
            cursor: "pointer",
          }}
        >
          ↳
        </button>
        <button
          type="button"
          onClick={onToggleFullscreen}
          title={fullscreen ? "Restore terminal" : "Fullscreen terminal"}
          aria-label={fullscreen ? "Restore terminal" : "Fullscreen terminal"}
          className="flex items-center justify-center rounded"
          style={{
            width: "20px",
            height: "20px",
            fontSize: "12px",
            lineHeight: 1,
            background: "var(--color-bg-elevated)",
            border: "1px solid var(--color-rule)",
            color: "var(--color-ink-muted)",
            cursor: "pointer",
          }}
        >
          {fullscreen ? "⤡" : "⤢"}
        </button>
      </div>
    </div>
  );
}
