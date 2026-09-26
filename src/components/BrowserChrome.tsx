// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useLayoutEffect, useRef, type PointerEvent } from "react";
import { ArrowLeft, ArrowRight, Columns2, Globe2, Grid3x3, MessageSquare, MoreHorizontal, Palette, Plus, RotateCw, Scan, Settings2, Star, X } from "lucide-react";
import { BrowserMenuItem, BrowserPopover } from "./BrowserSurfaces";
import type { TilePage } from "./BrowserTileStage";

interface Props {
  tabs: TilePage[]; activeId: string; address: string; onAddress: (value: string) => void;
  onAddressFocus: (focused: boolean) => void; onNavigate: () => void;
  onAddressCopyError?: () => void;
  onBack: () => void; onForward: () => void; onReload: () => void;
  onSelect: (id: string) => void; onCloseTab: (id: string) => void; onNewTab: () => void;
  onTabDrag: (event: PointerEvent, id: string) => void;
  chatOpen: boolean; onToggleChat: () => void; split: boolean; onArrange: () => void;
  onMosaics: () => void;
  tileBadges?: Record<string, number>; hoveredTileTab?: string | null; onHoverTile?: (browseId: string | null) => void;
  /** The open mosaic, if any: a contextual chip that names it and closes it. */
  mosaic?: { name: string; onClose: () => void } | null;
  menuOpen: boolean; onMenu: (open: boolean) => void;
  onBookmarks: () => void; onAppearance: () => void; onPreferences: () => void;
  onInspect: () => void; onCloseBrowser: () => void;
}

export function BrowserChrome(props: Props) {
  const menuButton = useRef<HTMLButtonElement>(null);
  const tabNodes = useRef(new Map<string, HTMLDivElement>());
  const closingFocus = useRef<string | null>(null);
  const addressPress = useRef<{ x: number; y: number; wasFocused: boolean } | null>(null);
  const closeTab = (id: string) => {
    if (id === props.activeId || tabNodes.current.get(id)?.contains(document.activeElement)) closingFocus.current = id;
    props.onCloseTab(id);
  };
  useLayoutEffect(() => {
    if (!closingFocus.current || props.tabs.some((tab) => tab.id === closingFocus.current)) return;
    closingFocus.current = null;
    (tabNodes.current.get(props.activeId) ?? tabNodes.current.get(props.tabs[0]?.id))?.focus();
  }, [props.tabs, props.activeId]);
  const act = (fn: () => void) => () => { props.onMenu(false); fn(); };
  return <header className="rb-chrome" aria-label="Browser navigation">
    <div className="rb-tabs-row">
      <div className="rb-tabs rl-hide-scroll-x" role="tablist" aria-label="Browser tabs" onKeyDown={(event) => {
        if (!(event.target as HTMLElement).closest('[data-tab-id]')) return;
        if (event.altKey || event.ctrlKey || event.metaKey || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation();
        const focusedId = (event.target as HTMLElement).closest('[data-tab-id]')?.getAttribute("data-tab-id");
        const i = props.tabs.findIndex((tab) => tab.id === (focusedId ?? props.activeId));
        const next = event.key === "Home" ? 0 : event.key === "End" ? props.tabs.length - 1 : (i + (event.key === "ArrowRight" ? 1 : props.tabs.length - 1)) % props.tabs.length;
        const tab = props.tabs[next]; if (tab) { props.onSelect(tab.id); tabNodes.current.get(tab.id)?.focus(); }
      }}>
        {props.tabs.map((tab, i) => <div key={tab.id} ref={(node) => { if (node) tabNodes.current.set(tab.id, node); else tabNodes.current.delete(tab.id); }} role="tab" aria-label={tab.title || "New tab"} aria-selected={tab.id === props.activeId} tabIndex={tab.id === props.activeId ? 0 : -1} data-tab-id={tab.id}
          className="rb-tab" data-tile-hover={props.hoveredTileTab === tab.browseId || undefined}
          onPointerEnter={() => props.onHoverTile?.(tab.browseId)} onPointerLeave={() => props.onHoverTile?.(null)}
          title={`${i + 1}. ${tab.title}\n${tab.url}`} onClick={(e) => { e.currentTarget.focus({ preventScroll: true }); props.onSelect(tab.id); }} onPointerDown={(e) => {
            if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
            // Drag capture prevents the default focus transfer. Move focus
            // explicitly so the address bar does not stay selected on tab clicks.
            e.currentTarget.focus({ preventScroll: true });
            props.onTabDrag(e, tab.id);
          }}
          onKeyDown={(e) => { if (e.target !== e.currentTarget) return; if (e.key === "Enter" || e.key === " ") { e.preventDefault(); props.onSelect(tab.id); } else if (e.key === "Delete") { e.preventDefault(); e.stopPropagation(); closeTab(tab.id); } }}
          onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); closeTab(tab.id); } }}>
          {props.tileBadges?.[tab.browseId] && <span className="rb-tile-badge" aria-label={`Tile ${props.tileBadges[tab.browseId]}`}>{props.tileBadges[tab.browseId]}</span>}<Globe2 size={14} aria-hidden/><span className="rb-tab-title">{tab.title || "New tab"}</span>
          <button type="button" className="rb-tab-close" tabIndex={tab.id === props.activeId ? 0 : -1} aria-label={`Close ${tab.title || "tab"}`} onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}><X size={12}/></button>
        </div>)}
        <button type="button" className="rb-icon-button rb-new-tab" title="New tab (⌘T)" aria-label="New tab" disabled={props.tabs.length >= 100} onClick={props.onNewTab}><Plus size={17}/></button>
      </div>
    </div>
    <div className="rb-navigation-row">
      <div className="rb-history"><button type="button" className="rb-icon-button" aria-label="Back" title="Back" onClick={props.onBack}><ArrowLeft size={17}/></button>
        <button type="button" className="rb-icon-button" aria-label="Forward" title="Forward" onClick={props.onForward}><ArrowRight size={17}/></button>
        <button type="button" className="rb-icon-button" aria-label="Reload page" title="Reload page (⌘R)" onClick={props.onReload}><RotateCw size={16}/></button></div>
      <form className="rb-address" onSubmit={(e) => { e.preventDefault(); props.onNavigate(); }}>
        <input aria-label="Address or search" value={props.address} onChange={(e) => props.onAddress(e.target.value)}
          onMouseDown={(e) => { addressPress.current = { x: e.clientX, y: e.clientY, wasFocused: document.activeElement === e.currentTarget }; }}
          onFocus={(e) => { props.onAddressFocus(true); e.currentTarget.select(); }}
          onMouseUp={(e) => {
            const press = addressPress.current; addressPress.current = null;
            // WebKit can collapse the focus-time selection on mouseup. Keep a
            // first click selected, while allowing later clicks and range drags.
            if (press && !press.wasFocused && Math.hypot(e.clientX - press.x, e.clientY - press.y) < 4) { e.preventDefault(); e.currentTarget.select(); }
          }}
          onCopy={(e) => {
            const input = e.currentTarget, start = input.selectionStart ?? 0, end = input.selectionEnd ?? start;
            if (end > start) { e.clipboardData.setData("text/plain", input.value.slice(start, end)); e.preventDefault(); }
          }}
          onKeyDown={(e) => {
            if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== "c" || !navigator.clipboard?.writeText) return;
            const input = e.currentTarget, start = input.selectionStart ?? 0, end = input.selectionEnd ?? start;
            if (end <= start) return;
            const selected = input.value.slice(start, end);
            e.preventDefault();
            // Native menu accelerators and DOM key events take different paths
            // in a multi-webview window. Handle either path with this selection.
            void navigator.clipboard.writeText(selected).catch(() => {
              let copied = false;
              try { copied = document.activeElement === input && input.selectionStart === start && input.selectionEnd === end && input.value.slice(start, end) === selected && document.execCommand("copy"); } catch { /* fall through to the visible error */ }
              if (!copied) props.onAddressCopyError?.();
            });
          }}
          onBlur={() => { addressPress.current = null; props.onAddressFocus(false); }}
          placeholder="Search or enter a website" spellCheck={false} autoCapitalize="off" autoCorrect="off"/>
      </form>
      {props.mosaic && <span className="rb-mosaic-chip">
        <button type="button" title="Mosaics" onClick={props.onMosaics}><Grid3x3 size={14} aria-hidden/><span className="truncate">{props.mosaic.name}</span></button>
        <button type="button" className="rb-icon-button" aria-label={`Close ${props.mosaic.name}`} title="Close mosaic" onClick={props.mosaic.onClose}><X size={12}/></button>
      </span>}
      {props.split && <button type="button" className="rb-icon-button" aria-label="Arrange pages" title="Arrange pages" onClick={props.onArrange}><Columns2 size={17}/></button>}
      <button type="button" className="rb-chat-toggle" aria-label="Toggle browser chat" aria-pressed={props.chatOpen} onClick={props.onToggleChat}><MessageSquare size={16}/><span>Chat</span></button>
      <button type="button" ref={menuButton} className="rb-icon-button" aria-label="Page menu" title="Page menu" aria-haspopup="menu" aria-expanded={props.menuOpen} onClick={() => props.onMenu(!props.menuOpen)}><MoreHorizontal size={19}/></button>
    </div>
    {props.menuOpen && <BrowserPopover anchor={menuButton} title="Page menu" onClose={() => props.onMenu(false)}>
      <BrowserMenuItem icon={<Columns2 size={16}/>} onClick={act(props.onArrange)}>Arrange pages…</BrowserMenuItem>
      <BrowserMenuItem icon={<Grid3x3 size={16}/>} onClick={act(props.onMosaics)}>Mosaics…</BrowserMenuItem>
      <div className="rb-menu-rule"/>
      <BrowserMenuItem icon={<Star size={16}/>} onClick={act(props.onBookmarks)}>Bookmarks…</BrowserMenuItem>
      <BrowserMenuItem icon={<Palette size={16}/>} onClick={act(props.onAppearance)}>Page appearance…</BrowserMenuItem>
      <BrowserMenuItem icon={<Scan size={16}/>} onClick={act(props.onInspect)}>Select an element to discuss</BrowserMenuItem>
      <div className="rb-menu-rule"/>
      <BrowserMenuItem icon={<Settings2 size={16}/>} onClick={act(props.onPreferences)}>Browsing preferences…</BrowserMenuItem>
      <BrowserMenuItem icon={<ArrowLeft size={16}/>} onClick={act(props.onCloseBrowser)}>Return to Redline</BrowserMenuItem>
    </BrowserPopover>}
  </header>;
}
