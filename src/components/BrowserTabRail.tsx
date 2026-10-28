// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// The browser's own tab strip, down the pane's left edge. Icon-only (40 px)
// by default: "Show tab titles", New tab, then a 28 px button per page with
// its favicon, the one status vocabulary in its corner (working = the shared
// Spinner, suspended = muted, idle = nothing) and its tile number while
// pages are tiled; Recently closed sits at the foot. Showing titles widens
// it to a resizable list with In order / Organized.
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent, type CSSProperties } from "react";
import { ChevronDown, ChevronsLeft, ChevronsRight, Globe, History, Plus, Sparkles, X } from "lucide-react";
import { beginResizeSession, endResizeSession } from "../lib/resizeSession";
import { Spinner } from "./Spinner";
import { BrowserMenuItem, BrowserPopover } from "./BrowserSurfaces";
import type { TilePage } from "./BrowserTileStage";
import type { TabGroup } from "../lib/tabGroups";
import type { ClosedPage } from "../lib/browserNewTab";

/** The icon-only strip's width, and the default. */
export const RAIL_ICON_WIDTH = 40;
const RAIL_MIN = 168, RAIL_MAX = 320, RAIL_TITLES = 220;
const WIDTH_KEY = "redline.browser.railWidth";

function storedWidth(): number {
  const n = Number(localStorage.getItem(WIDTH_KEY));
  // Nothing stored, or the old 48 px collapsed width: the icon strip.
  if (!n || n <= 48) return RAIL_ICON_WIDTH;
  return Math.max(RAIL_MIN, Math.min(RAIL_MAX, n));
}

interface Props {
  tabs: TilePage[]; activeId: string; onSelect: (id: string) => void; onCloseTab: (id: string) => void; onNewTab: () => void;
  onTabDrag: (event: PointerEvent, id: string) => void; onResize: () => void;
  tileBadges?: Record<string, number>; hoveredTileTab?: string | null; onHoverTile?: (id: string | null) => void;
  /** Tabs the agent is acting on: a spinner until the turn ends (BC-41). */
  acting?: ReadonlySet<string>;
  /** Tabs reloading or waking: a spinner too. */
  loading?: ReadonlySet<string>;
  /** Tabs suspended to their snapshot: muted. */
  suspended?: ReadonlySet<string>;
  /** Pages that could not load, by tab id: they need you. */
  failed?: Readonly<Record<string, string>>;
  /** Pages closed in this pane, newest first, and how one comes back. */
  closed?: readonly ClosedPage[]; onReopen?: (page: ClosedPage) => void;
  groups: TabGroup[]; organized: boolean; organizing: boolean; onMode: (value: boolean) => void;
  onOrganize: () => void; onToggleGroup: (id: string) => void;
}
export default function BrowserTabRail(props: Props) {
  const tabNodes = useRef(new Map<string, HTMLDivElement>()), closingFocus = useRef<string | null>(null);
  const rail = useRef<HTMLElement>(null), drag = useRef<{ x: number; width: number } | null>(null), closedButton = useRef<HTMLButtonElement>(null);
  const [failedFavicons, setFailedFavicons] = useState<Record<string, boolean>>({});
  const [closedOpen, setClosedOpen] = useState(false);
  const [width, setWidth] = useState(storedWidth);
  const endDrag = () => { if (drag.current) { drag.current = null; endResizeSession(); } };
  useEffect(() => () => endDrag(), []);
  const collapsed = width === RAIL_ICON_WIDTH;
  const resize = (next: number) => { setWidth(next); localStorage.setItem(WIDTH_KEY, String(next)); props.onResize(); };
  const closeTab = (id: string) => { if (id === props.activeId || tabNodes.current.get(id)?.contains(document.activeElement)) closingFocus.current = id; props.onCloseTab(id); };
  useLayoutEffect(() => { if (!closingFocus.current || props.tabs.some(tab => tab.id === closingFocus.current)) return; closingFocus.current = null; tabNodes.current.get(props.activeId)?.focus(); }, [props.tabs, props.activeId]);
  const renderTab = (tab: TilePage, index: number) => {
    // A page that could not load needs you even while its navigation still
    // "loads": a refused or unresolved address never commits, so its
    // loading flag would otherwise hide the amber dot forever.
    const failed = !!props.failed?.[tab.id];
    const acting = !!props.acting?.has(tab.id), working = acting || (!failed && !!props.loading?.has(tab.id));
    const needs = !acting && failed;
    const suspended = !working && !needs && !!props.suspended?.has(tab.id);
    const badge = props.tileBadges?.[tab.browseId];
    const title = tab.title || "New tab";
    return <div key={tab.id} ref={node => { if (node) tabNodes.current.set(tab.id, node); else tabNodes.current.delete(tab.id); }} role="tab" aria-label={`${title}${acting ? " — the agent is acting on this page" : props.failed?.[tab.id] ? " — this page could not load" : ""}`} aria-selected={tab.id === props.activeId} tabIndex={tab.id === props.activeId ? 0 : -1} data-tab-id={tab.id} className="rb-tab" data-tile-hover={props.hoveredTileTab === tab.browseId || undefined} data-agent-acting={acting || undefined}
      data-status={working ? "working" : needs ? "needs" : suspended ? "suspended" : undefined}
      title={`${index + 1} · ${title}\n${tab.url}`} onPointerEnter={() => props.onHoverTile?.(tab.browseId)} onPointerLeave={() => props.onHoverTile?.(null)}
      onClick={event => { event.currentTarget.focus({ preventScroll: true }); props.onSelect(tab.id); }}
      onPointerDown={event => { if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return; event.currentTarget.focus({ preventScroll: true }); props.onTabDrag(event, tab.id); }}
      onKeyDown={event => { if (event.target !== event.currentTarget) return; if (["Enter", " "].includes(event.key)) { event.preventDefault(); props.onSelect(tab.id); } else if (event.key === "Delete") { event.preventDefault(); closeTab(tab.id); } }}
      onAuxClick={event => { if (event.button === 1) { event.preventDefault(); closeTab(tab.id); } }}>
      {tab.favicon && !failedFavicons[tab.favicon] ? <img className="rb-favicon" src={tab.favicon} alt="" referrerPolicy="no-referrer" onError={() => setFailedFavicons(failed => ({ ...failed, [tab.favicon!]: true }))}/>: <Globe size={16} aria-hidden/>}
      {working && <Spinner size={10} className="rb-tab-status"/>}
      {needs && <i className="rb-needs-dot rb-tab-status" aria-hidden/>}
      <span className="rb-tab-title">{title}</span>
      {badge && <span className="rb-tile-badge" aria-label={`Tile ${badge}`}>{badge}</span>}
      {<button type="button" className="rb-tab-close" tabIndex={tab.id === props.activeId ? 0 : -1} aria-label={`Close ${tab.title || "tab"}`} onClick={event => { event.stopPropagation(); closeTab(tab.id); }}><X size={12}/></button>}
    </div>;
  };
  const ordered = props.organized && !collapsed
    ? props.groups.map(group => <section key={group.id} data-tab-group={group.id}><button className="rb-group-title" aria-expanded={!group.collapsed} onClick={() => props.onToggleGroup(group.id)}><ChevronDown size={12}/>{group.name}<span>{group.browseIds.length}</span></button>{!group.collapsed && group.browseIds.map(id => props.tabs.findIndex(tab => tab.browseId === id)).filter(i => i >= 0).map(i => renderTab(props.tabs[i], i))}</section>)
    : props.tabs.map(renderTab);
  const closed = props.closed ?? [];
  return <aside ref={rail} className="rb-tab-rail" data-collapsed={collapsed || undefined} aria-label="Browser tabs" style={{ "--browser-rail-width": `${width}px` } as CSSProperties}>
    <div className="rb-rail-heading">
      <button type="button" className="rb-icon-button" aria-label={collapsed ? "Show tab titles" : "Hide tab titles"} title={collapsed ? "Show tab titles" : "Hide tab titles"} onClick={() => resize(collapsed ? RAIL_TITLES : RAIL_ICON_WIDTH)}>{collapsed ? <ChevronsRight size={16}/> : <ChevronsLeft size={16}/>}</button>
      {!collapsed && <strong>Pages</strong>}
      <button type="button" className="rb-icon-button" aria-label="New tab" title="New tab" disabled={props.tabs.length >= 100} onClick={props.onNewTab}><Plus size={16}/></button>
    </div>
    {collapsed ? <span className="rb-rail-rule" aria-hidden/> : <><div className="rb-rail-mode" role="group" aria-label="Tab order"><button aria-pressed={!props.organized} onClick={() => props.onMode(false)}>In order</button><button aria-pressed={props.organized} onClick={() => props.onMode(true)}>Organized</button></div>{props.organized && <button className="rb-button rb-organize" disabled={props.organizing} onClick={props.onOrganize}><Sparkles size={13}/>{props.organizing ? "Organizing…" : "Organize"}</button>}</>}
    <div className="rb-tabs" role="tablist" aria-label="Browser pages" aria-orientation="vertical" onKeyDown={event => {
      if (!(event.target as HTMLElement).closest('[data-tab-id]') || event.altKey || event.ctrlKey || event.metaKey || !["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
      event.preventDefault(); const ids = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-tab-id]')].map(node => node.dataset.tabId!);
      const i = ids.indexOf((event.target as HTMLElement).closest<HTMLElement>('[data-tab-id]')!.dataset.tabId!);
      const id = ids[event.key === "Home" ? 0 : event.key === "End" ? ids.length - 1 : (i + (event.key === "ArrowDown" ? 1 : ids.length - 1)) % ids.length];
      if (id) { props.onSelect(id); tabNodes.current.get(id)?.focus(); }
    }}>{ordered}</div>
    <div className="rb-rail-foot">
      <button ref={closedButton} type="button" className="rb-icon-button" aria-label="Recently closed" title={closed.length ? `Recently closed · ${closed.length}` : "Nothing closed yet"} aria-haspopup="menu" aria-expanded={closedOpen} disabled={!closed.length} onClick={() => setClosedOpen(open => !open)}><History size={16}/>{!collapsed && <span>Recently closed</span>}</button>
    </div>
    {closedOpen && closed.length > 0 && <BrowserPopover anchor={closedButton} title="Recently closed" onClose={() => setClosedOpen(false)}>
      {closed.map(page => <BrowserMenuItem key={page.url} icon={<Globe size={16}/>} onClick={() => { setClosedOpen(false); props.onReopen?.(page); }}>{page.title || page.url}</BrowserMenuItem>)}
    </BrowserPopover>}
    <div role="separator" aria-label="Resize tab rail" aria-orientation="vertical" aria-valuenow={width} aria-valuemin={RAIL_ICON_WIDTH} aria-valuemax={RAIL_MAX} tabIndex={0} className="rb-rail-resize"
      onKeyDown={event => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) { event.preventDefault(); resize(event.key === "Home" ? RAIL_ICON_WIDTH : event.key === "End" ? RAIL_MAX : Math.max(RAIL_MIN, Math.min(RAIL_MAX, width + (event.key === "ArrowRight" ? 16 : -16)))); } }}
      onPointerDown={event => { if (event.button) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); endDrag(); drag.current = { x: event.clientX, width }; beginResizeSession(); }}
      onPointerMove={event => { if (!drag.current) return; const value = Math.max(RAIL_ICON_WIDTH, Math.min(RAIL_MAX, drag.current.width + event.clientX - drag.current.x)); rail.current?.style.setProperty("--browser-rail-width", `${value < 110 ? RAIL_ICON_WIDTH : Math.max(RAIL_MIN, value)}px`); props.onResize(); }}
      onPointerUp={() => { if (drag.current) resize(parseFloat(rail.current?.style.getPropertyValue("--browser-rail-width") || String(RAIL_TITLES))); endDrag(); }} onLostPointerCapture={endDrag} onPointerCancel={() => { endDrag(); rail.current?.style.setProperty("--browser-rail-width", `${width}px`); props.onResize(); }}/>
  </aside>;
}
