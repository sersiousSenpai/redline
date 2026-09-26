// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState, type RefObject } from "react";
import { Maximize2, Minimize2, Plus, ChevronDown, GripVertical } from "lucide-react";
import { crossedDragThreshold } from "../lib/browserTabDrag";
import { BrowserMenuItem, BrowserPopover } from "./BrowserSurfaces";
import { clampDivider, tileRects, type BrowserLayout } from "../lib/browserLayout";

export interface TilePage { id: string; browseId: string; title: string; url: string }
interface Props {
  stageRef: RefObject<HTMLDivElement | null>;
  slots: RefObject<Map<string, HTMLDivElement>>;
  pages: TilePage[];
  tabs: TilePage[];
  activeId: string;
  layout: BrowserLayout;
  fullscreen: boolean;
  shots: Map<string, string>;
  showShots: boolean;
  errors?: Record<string, string>;
  loading?: Set<string>;
  onRetry?: (id: string) => void;
  onFocus: (id: string) => void;
  onAssign: (index: number, browseId: string) => void;
  /** An empty mosaic slot's "Add a page". */
  onAddPage?: (index: number) => void;
  onLayout: (patch: Partial<BrowserLayout>) => void;
  onDragging: (value: boolean) => void;
  hoveredTileTab?: string | null; onHoverTile?: (browseId: string | null) => void;
  onSwap?: (from: number, to: number) => void;
}
export function BrowserTileStage({ stageRef, slots, pages, tabs, activeId, layout, fullscreen, shots, showShots, errors = {}, loading, onRetry, onFocus, onAssign, onAddPage, onLayout, onDragging, hoveredTileTab, onHoverTile, onSwap }: Props) {
  const drag = useRef<{ axis: "horizontal" | "vertical"; rect: DOMRect } | null>(null);
  const rects = tileRects(pages.length, layout);
  // A grid draws every cell, filled or not; a freeform arrangement draws its pages.
  const cellCount = layout.grid ? rects.length : pages.length;
  const tiled = cellCount > 1;
  const toggleMaximized = (page: TilePage) => { onFocus(page.id); onLayout({ maximized: layout.maximized ? null : page.browseId }); };
  function divider(axis: "horizontal" | "vertical") {
    const horizontal = axis === "horizontal";
    return <div role="separator" aria-label={horizontal ? "Resize page columns" : "Resize page rows"}
      aria-orientation={horizontal ? "vertical" : "horizontal"} aria-valuemin={20} aria-valuemax={80} aria-valuenow={Math.round(layout[axis] * 100)} tabIndex={0}
      onKeyDown={(e) => { const step = e.key === (horizontal ? "ArrowRight" : "ArrowDown") ? .025 : e.key === (horizontal ? "ArrowLeft" : "ArrowUp") ? -.025 : 0; if (step || e.key === "Home" || e.key === "End") { e.preventDefault(); onLayout({ [axis]: e.key === "Home" ? .2 : e.key === "End" ? .8 : clampDivider(layout[axis] + step) }); } if (e.key === "Escape") { drag.current = null; onDragging(false); } }}
      onPointerDown={(e) => { if (e.button !== 0 || !stageRef.current) return; e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); drag.current = { axis, rect: stageRef.current.getBoundingClientRect() }; onDragging(true); }}
      onPointerMove={(e) => { const d = drag.current; if (!d) return; onLayout({ [d.axis]: clampDivider(d.axis === "horizontal" ? (e.clientX - d.rect.left) / d.rect.width : (e.clientY - d.rect.top) / d.rect.height) }); }}
      onPointerUp={() => { drag.current = null; onDragging(false); }} onPointerCancel={() => { drag.current = null; onDragging(false); }} onLostPointerCapture={() => { drag.current = null; onDragging(false); }}
      style={{ position: "absolute", zIndex: 3, background: "var(--color-rule)", ...(horizontal ? { top: 0, bottom: 0, left: `calc(${layout.horizontal * 100}% - 3px)`, width: 6, cursor: "col-resize" } : { left: pages.length === 3 ? `${layout.horizontal * 100}%` : 0, right: 0, top: `calc(${layout.vertical * 100}% - 3px)`, height: 6, cursor: "row-resize" }) }} />;
  }
  return <div ref={stageRef} className="relative flex-1 min-h-0 min-w-0 overflow-hidden" data-grid={layout.grid ? `${layout.grid.rows}x${layout.grid.cols}` : undefined} style={{ background: "var(--color-paper)" }}>
    {Array.from({ length: cellCount }, (_, i) => { const r = rects[i], page = pages[i];
      const place = { position: "absolute", left: `${r.left}%`, top: `${r.top}%`, width: `${r.width}%`, height: `${r.height}%`, display: "flex", flexDirection: "column", padding: tiled ? 3 : 0 } as const;
      if (!page) return <section key={`empty-${i}`} data-tile-index={i} aria-label={`Empty space ${i + 1}`} style={place}>
        <button type="button" className="rb-tile-empty" onClick={() => onAddPage?.(i)} disabled={!onAddPage}><Plus size={16} aria-hidden/><span>Add a page</span></button>
      </section>;
      return <section key={page.browseId} data-tile-index={i} aria-label={`Page ${i + 1}: ${page.title}`} style={place}>
      {!fullscreen && (tiled || layout.maximized) && <TileHeader page={page} index={i} tabs={tabs} pages={pages}
        active={activeId === page.id} maximized={!!layout.maximized} hovered={hoveredTileTab === page.browseId}
        onHover={onHoverTile} onAssign={onAssign} onFocus={() => onFocus(page.id)} onMaximize={() => toggleMaximized(page)}
        onDragging={onDragging} onSwap={onSwap}/>}
      <div ref={(node) => { if (node) slots.current.set(page.id, node); else slots.current.delete(page.id); }} className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
        {errors[page.id] ? <div className="rb-page-cover" role="alert"><strong>Page unavailable</strong><p>{errors[page.id]}</p><button type="button" className="rb-button" onClick={() => onRetry?.(page.id)}>Try again</button></div>
          : loading?.has(page.id) && <div className="rb-page-cover" role="status"><span>Opening {page.title || "page"}…</span></div>}
        {showShots && !errors[page.id] && shots.get(page.id) && <img src={shots.get(page.id)} alt="" aria-hidden draggable={false} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", objectPosition: "top left", pointerEvents: "none" }}/>}
      </div>
    </section>; })}
    {!fullscreen && !layout.grid && pages.length > 1 && divider("horizontal")}
    {!fullscreen && !layout.grid && pages.length > 2 && divider("vertical")}
  </div>;
}

function TileHeader({ page, index, tabs, pages, active, maximized, hovered, onHover, onAssign, onFocus, onMaximize, onDragging, onSwap }: {
  page: TilePage; index: number; tabs: TilePage[]; pages: TilePage[]; active: boolean; maximized: boolean; hovered: boolean;
  onHover?: (id: string | null) => void; onAssign: (index: number, id: string) => void; onFocus: () => void;
  onMaximize: () => void; onDragging: (value: boolean) => void; onSwap?: (from: number, to: number) => void;
}) {
  const picker = useRef<HTMLButtonElement>(null), cleanupRef = useRef<(() => void) | null>(null), suppressClick = useRef(false);
  const [open, setOpen] = useState(false);
  useEffect(() => () => cleanupRef.current?.(), []);
  return <div className="rb-tile-header flex shrink-0 items-center gap-1 px-2" data-tile-hover={hovered || undefined}
    onPointerEnter={() => onHover?.(page.browseId)} onPointerLeave={() => onHover?.(null)}
    onClickCapture={e => { if (suppressClick.current) { e.preventDefault(); e.stopPropagation(); suppressClick.current = false; } }}
    onDoubleClick={e => { if (!(e.target as HTMLElement).closest("button")) onMaximize(); }}
    onPointerDown={event => {
      if (event.button !== 0 || !onSwap || (event.target as HTMLElement).closest("[data-no-tile-drag]")) return;
      event.preventDefault();
      cleanupRef.current?.();
      const node = (event.target as HTMLElement).closest("button") ?? event.currentTarget, pointerId = event.pointerId, x = event.clientX, y = event.clientY;
      node.setPointerCapture(pointerId);
      let moved = false, target: HTMLElement | null = null;
      const hit = (e: PointerEvent) => {
        target?.removeAttribute("data-tile-drop");
        target = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>("[data-tile-index]") ?? null;
        target?.setAttribute("data-tile-drop", "true");
      };
      const move = (e: PointerEvent) => {
        if (e.pointerId !== pointerId) return;
        if (!moved && !crossedDragThreshold(e.clientX - x, e.clientY - y)) return;
        if (!moved) { moved = true; onDragging(true); }
        hit(e);
      };
      const cleanup = () => {
        window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", cleanup); window.removeEventListener("blur", cleanup); window.removeEventListener("keydown", key);
        node.removeEventListener("lostpointercapture", cleanup);
        if (node.hasPointerCapture(pointerId)) node.releasePointerCapture(pointerId);
        target?.removeAttribute("data-tile-drop");
        if (moved) { onDragging(false); suppressClick.current = true; setTimeout(() => { suppressClick.current = false; }, 0); }
        cleanupRef.current = null;
      };
      const up = (e: PointerEvent) => {
        if (e.pointerId !== pointerId) return;
        if (moved) hit(e);
        const to = target ? Number(target.dataset.tileIndex) : -1;
        cleanup();
        if (moved && to >= 0 && to !== index) onSwap(index, to);
      };
      const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); cleanup(); } };
      window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", cleanup); window.addEventListener("blur", cleanup); window.addEventListener("keydown", key);
      node.addEventListener("lostpointercapture", cleanup); cleanupRef.current = cleanup;
    }}
    style={{ height: 30, cursor: "grab", userSelect: "none", background: active ? "var(--color-bg-elevated)" : "var(--color-paper)", borderBottom: `2px solid ${active ? "var(--color-info)" : "var(--color-rule)"}` }}>
    <GripVertical size={12} aria-hidden/>
    <button type="button" className="rb-tile-badge" onClick={onFocus} aria-label={`Focus page ${index + 1}`}>{index + 1}</button>
    <button ref={picker} type="button" className="rb-tile-picker" aria-label={`Assign tab to page ${index + 1}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <span className="truncate flex-1">{page.title || page.url}</span><ChevronDown size={12}/>
    </button>
    <button data-no-tile-drag type="button" aria-label={maximized ? "Restore tiled layout" : "Maximize page"} onClick={onMaximize}>
      {maximized ? <Minimize2 size={12}/> : <Maximize2 size={12}/>}
    </button>
    {open && <BrowserPopover anchor={picker} title={`Choose page ${index + 1}`} onClose={() => setOpen(false)}>
      {tabs.map(tab => { const assigned = pages.findIndex(item => item.browseId === tab.browseId); return <BrowserMenuItem key={tab.browseId} selected={tab.browseId === page.browseId}
        onClick={() => { setOpen(false); onAssign(index, tab.browseId); }}>{tab.title || tab.url}{assigned >= 0 ? ` · Tile ${assigned + 1}` : ""}</BrowserMenuItem>; })}
    </BrowserPopover>}
  </div>;
}
