// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useRef, type PointerEvent } from "react";
import { ArrowLeft, ArrowRight, Columns2, Download, Grid3x3, MessageSquare, MoreHorizontal, Palette, Printer, RotateCw, Scan, Settings2, Star, X } from "lucide-react";
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
}

export function BrowserChrome(props: Props) {
  const menuButton = useRef<HTMLButtonElement>(null);
  const addressPress = useRef<{ x: number; y: number; wasFocused: boolean } | null>(null);
  const act = (fn: () => void) => () => { props.onMenu(false); fn(); };
  return <header className="rb-chrome" aria-label="Browser navigation">
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
