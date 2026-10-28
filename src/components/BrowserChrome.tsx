// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useRef, type PointerEvent } from "react";
import { ArrowLeft, ArrowRight, Columns2, Download, Globe, Grid3x3, Link2, Lock, MessageSquare, MoreHorizontal, Palette, Printer, RotateCw, Scan, Search, Settings2, Star, Target, X } from "lucide-react";
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
  onPrint?: () => void; onSavePage?: () => void;
  /** The page on screen is the new-tab page (no page, no history). */
  newTab?: boolean;
  /** Research missions (🎯): the pane's own entry, beside the page chat's. */
  onResearch?: () => void;
  /** One discussion across tabs (🔗), when the page chat can be linked. */
  linked?: boolean; onToggleLinked?: () => void;
  /** The ports the Localhost scan lists as running dev servers: the address
   *  wears "dev server" only for one of them, never for any loopback port
   *  (127.0.0.1:1 refused the connection and still read as a dev server). */
  devServerPorts?: readonly number[];
}

/** A local dev server's address: localhost, 127.0.0.1 or 0.0.0.0, on a port
 *  the Localhost discovery lists as serving. Without the list (`undefined`)
 *  nothing is called a dev server: a loopback address alone says nothing
 *  about whether anything answers there. */
export function isDevServerUrl(url: string, ports?: readonly number[]): boolean {
  if (!ports?.length) return false;
  try {
    const { protocol, hostname, port } = new URL(url);
    if (!/^https?:$/.test(protocol) || !/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/i.test(hostname)) return false;
    const n = Number(port || (protocol === "https:" ? 443 : 80));
    return ports.includes(n);
  } catch {
    return false;
  }
}

export function BrowserChrome(props: Props) {
  const menuButton = useRef<HTMLButtonElement>(null);
  const addressPress = useRef<{ x: number; y: number; wasFocused: boolean } | null>(null);
  const act = (fn: () => void) => () => { props.onMenu(false); fn(); };
  const address = props.address.trim();
  const secure = /^https:\/\//i.test(address);
  const devServer = !props.newTab && isDevServerUrl(address, props.devServerPorts);
  return <header className="rb-chrome" aria-label="Browser navigation">
    <div className="rb-navigation-row">
      <div className="rb-history"><button type="button" className="rb-icon-button" aria-label="Back" title="Back" disabled={props.newTab} onClick={props.onBack}><ArrowLeft size={16}/></button>
        <button type="button" className="rb-icon-button" aria-label="Forward" title="Forward" disabled={props.newTab} onClick={props.onForward}><ArrowRight size={16}/></button>
        <button type="button" className="rb-icon-button" aria-label="Reload page" title="Reload page (⌘R)" onClick={props.onReload}><RotateCw size={16}/></button></div>
      <form className="rb-address" data-secure={secure || undefined} onSubmit={(e) => { e.preventDefault(); props.onNavigate(); }}>
        <span className="rb-address-icon" aria-hidden>{props.newTab || !address ? <Search size={12}/> : secure ? <Lock size={12}/> : <Globe size={12}/>}</span>
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
        {devServer && <span className="rb-address-status" title="A dev server on this machine"><i aria-hidden/>dev server</span>}
      </form>
      {props.mosaic && <span className="rb-mosaic-chip">
        <button type="button" title="Mosaics" onClick={props.onMosaics}><Grid3x3 size={14} aria-hidden/><span className="truncate">{props.mosaic.name}</span></button>
        <button type="button" className="rb-icon-button" aria-label={`Close ${props.mosaic.name}`} title="Close mosaic" onClick={props.mosaic.onClose}><X size={12}/></button>
      </span>}
      {props.split && <button type="button" className="rb-icon-button" aria-label="Arrange pages" title="Arrange pages" onClick={props.onArrange}><Columns2 size={17}/></button>}
      <button type="button" className="rb-chat-toggle" aria-label="Page chat" title="Page chat" aria-pressed={props.chatOpen} onClick={props.onToggleChat}><MessageSquare size={14}/><span>Page chat</span></button>
      <button type="button" ref={menuButton} className="rb-icon-button" aria-label="Page menu" title="Page menu" aria-haspopup="menu" aria-expanded={props.menuOpen} onClick={() => props.onMenu(!props.menuOpen)}><MoreHorizontal size={16}/></button>
    </div>
    {props.menuOpen && <BrowserPopover anchor={menuButton} title="Page menu" onClose={() => props.onMenu(false)}>
      <BrowserMenuItem icon={<Columns2 size={16}/>} onClick={act(props.onArrange)}>Arrange pages…</BrowserMenuItem>
      <BrowserMenuItem icon={<Grid3x3 size={16}/>} onClick={act(props.onMosaics)}>Mosaics…</BrowserMenuItem>
      {props.onResearch && <BrowserMenuItem icon={<Target size={16}/>} onClick={act(props.onResearch)}>Research missions…</BrowserMenuItem>}
      {props.onToggleLinked && <BrowserMenuItem icon={<Link2 size={16}/>} selected={!!props.linked} onClick={act(props.onToggleLinked)}>One discussion across tabs</BrowserMenuItem>}
      <div className="rb-menu-rule"/>
      <BrowserMenuItem icon={<Star size={16}/>} onClick={act(props.onBookmarks)}>Bookmarks…</BrowserMenuItem>
      <BrowserMenuItem icon={<Palette size={16}/>} onClick={act(props.onAppearance)}>Page appearance…</BrowserMenuItem>
      <BrowserMenuItem icon={<Scan size={16}/>} onClick={act(props.onInspect)}>Select an element to discuss</BrowserMenuItem>
      {props.onPrint && props.onSavePage && <>
        <div className="rb-menu-rule"/>
        <BrowserMenuItem icon={<Printer size={16}/>} onClick={act(props.onPrint)}>Print…</BrowserMenuItem>
        <BrowserMenuItem icon={<Download size={16}/>} onClick={act(props.onSavePage)}>Save page/PDF</BrowserMenuItem>
      </>}
      <div className="rb-menu-rule"/>
      <BrowserMenuItem icon={<Settings2 size={16}/>} onClick={act(props.onPreferences)}>Browsing preferences…</BrowserMenuItem>
      <BrowserMenuItem icon={<ArrowLeft size={16}/>} onClick={act(props.onCloseBrowser)}>Return to Redline</BrowserMenuItem>
    </BrowserPopover>}
  </header>;
}
