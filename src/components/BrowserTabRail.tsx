// SPDX-License-Identifier: Apache-2.0
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent, type CSSProperties } from "react";
import { ChevronDown, ChevronsLeft, ChevronsRight, Globe2, Plus, Sparkles, X } from "lucide-react";
import { beginResizeSession, endResizeSession } from "../lib/resizeSession";
import type { TilePage } from "./BrowserTileStage";
import type { TabGroup } from "../lib/tabGroups";
interface Props {
  tabs: TilePage[]; activeId: string; onSelect: (id: string) => void; onCloseTab: (id: string) => void; onNewTab: () => void;
  onTabDrag: (event: PointerEvent, id: string) => void; onResize: () => void;
  tileBadges?: Record<string, number>; hoveredTileTab?: string | null; onHoverTile?: (id: string | null) => void;
  groups: TabGroup[]; organized: boolean; organizing: boolean; onMode: (value: boolean) => void;
  onOrganize: () => void; onToggleGroup: (id: string) => void;
}
export default function BrowserTabRail(props: Props) {
  const tabNodes = useRef(new Map<string, HTMLDivElement>()), closingFocus = useRef<string | null>(null);
  const rail = useRef<HTMLElement>(null), drag = useRef<{ x: number; width: number } | null>(null);
  const [failedFavicons, setFailedFavicons] = useState<Record<string, boolean>>({});
  const [width, setWidth] = useState(() => { const n = Number(localStorage.getItem("redline.browser.railWidth")); return n === 48 ? n : Math.max(168, Math.min(320, n || 220)); });
  const endDrag = () => { if (drag.current) { drag.current = null; endResizeSession(); } };
  useEffect(() => () => endDrag(), []);
  const collapsed = width === 48;
  const resize = (next: number) => { setWidth(next); localStorage.setItem("redline.browser.railWidth", String(next)); props.onResize(); };
  const closeTab = (id: string) => { if (id === props.activeId || tabNodes.current.get(id)?.contains(document.activeElement)) closingFocus.current = id; props.onCloseTab(id); };
  useLayoutEffect(() => { if (!closingFocus.current || props.tabs.some(tab => tab.id === closingFocus.current)) return; closingFocus.current = null; tabNodes.current.get(props.activeId)?.focus(); }, [props.tabs, props.activeId]);
  const renderTab = (tab: TilePage) => <div key={tab.id} ref={node => { if (node) tabNodes.current.set(tab.id, node); else tabNodes.current.delete(tab.id); }} role="tab" aria-label={tab.title || "New tab"} aria-selected={tab.id === props.activeId} tabIndex={tab.id === props.activeId ? 0 : -1} data-tab-id={tab.id} className="rb-tab" data-tile-hover={props.hoveredTileTab === tab.browseId || undefined}
    title={`${tab.title}\n${tab.url}`} onPointerEnter={() => props.onHoverTile?.(tab.browseId)} onPointerLeave={() => props.onHoverTile?.(null)}
    onClick={event => { event.currentTarget.focus({ preventScroll: true }); props.onSelect(tab.id); }}
    onPointerDown={event => { if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return; event.currentTarget.focus({ preventScroll: true }); props.onTabDrag(event, tab.id); }}
    onKeyDown={event => { if (event.target !== event.currentTarget) return; if (["Enter", " "].includes(event.key)) { event.preventDefault(); props.onSelect(tab.id); } else if (event.key === "Delete") { event.preventDefault(); closeTab(tab.id); } }}
    onAuxClick={event => { if (event.button === 1) { event.preventDefault(); closeTab(tab.id); } }}>
    {tab.favicon && !failedFavicons[tab.favicon] ? <img className="rb-favicon" src={tab.favicon} alt="" referrerPolicy="no-referrer" onError={() => setFailedFavicons(failed => ({ ...failed, [tab.favicon!]: true }))}/>: <Globe2 size={14} aria-hidden/>}
    {!collapsed && <><span className="rb-tab-title">{tab.title || "New tab"}</span>{props.tileBadges?.[tab.browseId] && <span className="rb-tile-badge" aria-label={`Tile ${props.tileBadges[tab.browseId]}`}>{props.tileBadges[tab.browseId]}</span>}<button type="button" className="rb-tab-close" tabIndex={tab.id === props.activeId ? 0 : -1} aria-label={`Close ${tab.title || "tab"}`} onClick={event => { event.stopPropagation(); closeTab(tab.id); }}><X size={12}/></button></>}
  </div>;
  return <aside ref={rail} className="rb-tab-rail" data-collapsed={collapsed || undefined} aria-label="Browser tabs" style={{ "--browser-rail-width": `${width}px` } as CSSProperties}>
    <div className="rb-rail-heading"><button className="rb-icon-button" aria-label={collapsed ? "Expand tab rail" : "Collapse tab rail"} onClick={() => resize(collapsed ? 220 : 48)}>{collapsed ? <ChevronsRight size={16}/> : <ChevronsLeft size={16}/>}</button>{!collapsed && <strong>Pages</strong>}<button className="rb-icon-button" aria-label="New tab" title="New tab (⌘T)" disabled={props.tabs.length >= 100} onClick={props.onNewTab}><Plus size={16}/></button></div>
    {!collapsed && <><div className="rb-rail-mode" role="group" aria-label="Tab order"><button aria-pressed={!props.organized} onClick={() => props.onMode(false)}>In order</button><button aria-pressed={props.organized} onClick={() => props.onMode(true)}>Organized</button></div>{props.organized && <button className="rb-button rb-organize" disabled={props.organizing} onClick={props.onOrganize}><Sparkles size={13}/>{props.organizing ? "Organizing…" : "Organize"}</button>}</>}
    <div className="rb-tabs" role="tablist" aria-label="Browser pages" aria-orientation="vertical" onKeyDown={event => {
      if (!(event.target as HTMLElement).closest('[data-tab-id]') || event.altKey || event.ctrlKey || event.metaKey || !["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
      event.preventDefault(); const ids = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-tab-id]')].map(node => node.dataset.tabId!);
      const i = ids.indexOf((event.target as HTMLElement).closest<HTMLElement>('[data-tab-id]')!.dataset.tabId!);
      const id = ids[event.key === "Home" ? 0 : event.key === "End" ? ids.length - 1 : (i + (event.key === "ArrowDown" ? 1 : ids.length - 1)) % ids.length];
      if (id) { props.onSelect(id); tabNodes.current.get(id)?.focus(); }
    }}>{props.organized && !collapsed ? props.groups.map(group => <section key={group.id} data-tab-group={group.id}><button className="rb-group-title" aria-expanded={!group.collapsed} onClick={() => props.onToggleGroup(group.id)}><ChevronDown size={12}/>{group.name}<span>{group.browseIds.length}</span></button>{!group.collapsed && group.browseIds.map(id => props.tabs.find(tab => tab.browseId === id)).filter((tab): tab is TilePage => !!tab).map(renderTab)}</section>) : props.tabs.map(renderTab)}</div>
    <div role="separator" aria-label="Resize tab rail" aria-orientation="vertical" aria-valuenow={width} aria-valuemin={48} aria-valuemax={320} tabIndex={0} className="rb-rail-resize"
      onKeyDown={event => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) { event.preventDefault(); resize(event.key === "Home" ? 48 : event.key === "End" ? 320 : Math.max(168, Math.min(320, width + (event.key === "ArrowRight" ? 16 : -16)))); } }}
      onPointerDown={event => { if (event.button) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); endDrag(); drag.current = { x: event.clientX, width }; beginResizeSession(); }}
      onPointerMove={event => { if (!drag.current) return; const value = Math.max(48, Math.min(320, drag.current.width + event.clientX - drag.current.x)); rail.current?.style.setProperty("--browser-rail-width", `${value < 110 ? 48 : Math.max(168, value)}px`); props.onResize(); }}
      onPointerUp={() => { if (drag.current) resize(parseFloat(rail.current?.style.getPropertyValue("--browser-rail-width") || "220")); endDrag(); }} onLostPointerCapture={endDrag} onPointerCancel={() => { endDrag(); rail.current?.style.setProperty("--browser-rail-width", `${width}px`); props.onResize(); }}/>
  </aside>;
}
