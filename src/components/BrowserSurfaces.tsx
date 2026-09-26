// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { createContext, useContext, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useMenuOverlay } from "./menuOverlay";
import "./BrowserWorkspace.css";

const MenuSemantics = createContext(true);
const tabOrder = (element: HTMLElement) => !element.hasAttribute("tabindex")
  && ["", "true", "plaintext-only"].includes(element.getAttribute("contenteditable")?.toLowerCase() ?? "inherit") ? 0 : element.tabIndex;

function visibleTabbables(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('a[href], area[href], button, input, select, textarea, summary, [contenteditable], [tabindex]')]
    .filter((element) => {
      if (tabOrder(element) < 0 || element.matches(':disabled, input[type="hidden"]') || element.closest('[inert], [aria-hidden="true"]') || ![...element.getClientRects()].some((rect) => rect.width > 0 && rect.height > 0)) return false;
      for (let node: HTMLElement | null = element; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (node.hidden || style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.opacity === "0" || style.contentVisibility === "hidden") return false;
        if (node !== element && node instanceof HTMLDetailsElement && !node.open) {
          const summary = [...node.children].find((child) => child.tagName === "SUMMARY");
          if (!summary?.contains(element)) return false;
        }
      }
      return true;
    })
    // Positive tabindex values precede the regular DOM-order controls.
    .sort((a, b) => (tabOrder(a) > 0 ? tabOrder(a) : Number.MAX_SAFE_INTEGER) - (tabOrder(b) > 0 ? tabOrder(b) : Number.MAX_SAFE_INTEGER));
}

function containKeys(event: React.KeyboardEvent, close: () => void) {
  event.stopPropagation();
  if (event.key === "Escape") { event.preventDefault(); close(); return; }
  const controls = visibleTabbables(event.currentTarget as HTMLElement);
  const first = controls[0], last = controls[controls.length - 1];
  if (event.key === "Tab") {
    if (!first) { event.preventDefault(); (event.currentTarget as HTMLElement).focus(); }
    else if (!controls.includes(document.activeElement as HTMLElement)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
    else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
  if (event.currentTarget.getAttribute("role") === "menu" && !(event.target as HTMLElement).matches('input, textarea, select, [contenteditable="true"]') && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
    event.preventDefault();
    const items = controls.filter((control) => control.getAttribute("role")?.startsWith("menuitem"));
    const i = items.indexOf(document.activeElement as HTMLElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : i < 0 ? (event.key === "ArrowDown" ? 0 : items.length - 1) : (i + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
    items[next]?.focus();
  }
}

export function BrowserPopover({ anchor, title, onClose, children, menu = true, width = 272 }: {
  anchor: RefObject<HTMLElement | null>; title: string; onClose: () => void; children: ReactNode; menu?: boolean; width?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 16, top: 64 });
  useMenuOverlay(true);
  useLayoutEffect(() => {
    const trigger = anchor.current;
    const place = () => {
      const rect = trigger?.getBoundingClientRect();
      if (!rect || !trigger?.isConnected) return;
      const maxWidth = Math.min(width, window.innerWidth - 32);
      const height = ref.current?.getBoundingClientRect().height ?? 0;
      const next = { left: Math.max(16, Math.min(rect.right - maxWidth, window.innerWidth - maxWidth - 16)), top: Math.max(48, Math.min(rect.bottom + 8, window.innerHeight - height - 16)) };
      setPosition((previous) => previous.left === next.left && previous.top === next.top ? previous : next);
    };
    place();
    const observer = new ResizeObserver(place);
    if (trigger) observer.observe(trigger);
    if (ref.current) observer.observe(ref.current);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { observer.disconnect(); window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [anchor, width]);
  useLayoutEffect(() => {
    const trigger = anchor.current, panel = ref.current;
    if (panel) (visibleTabbables(panel)[0] ?? panel).focus();
    return () => { if (trigger?.isConnected) trigger.focus(); };
  }, [anchor]);
  return createPortal(<MenuSemantics.Provider value={menu}><div className="rb-popover-cover" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div ref={ref} role={menu ? "menu" : "dialog"} aria-label={title} aria-modal={menu ? undefined : true} tabIndex={-1}
      className="rb-popover" style={{ ...position, width, maxWidth: "calc(100vw - 32px)", maxHeight: "calc(100dvh - 80px)" }} onKeyDown={(e) => containKeys(e, onClose)}>
      {children}
    </div>
  </div></MenuSemantics.Provider>, document.body);
}

export function BrowserMenuItem({ icon, children, onClick, shortcut, disabled, selected }: {
  icon?: ReactNode; children: ReactNode; onClick: () => void; shortcut?: string; disabled?: boolean; selected?: boolean;
}) {
  const menu = useContext(MenuSemantics);
  return <button type="button" role={menu ? selected === undefined ? "menuitem" : "menuitemradio" : undefined} aria-checked={menu ? selected : undefined} aria-pressed={menu ? undefined : selected} className="rb-menu-item" disabled={disabled} onClick={onClick}>
    {icon && <span className="rb-menu-icon" aria-hidden>{icon}</span>}<span className="rb-menu-label">{children}</span>{shortcut && <kbd>{shortcut}</kbd>}{selected && <span aria-hidden>✓</span>}
  </button>;
}

export function BrowserDialog({ title, subtitle, onClose, children, footer, width = 480, closeLabel = "Done" }: {
  title: string; subtitle?: string; onClose: () => void; children: ReactNode; footer?: ReactNode; width?: number; closeLabel?: string;
}) {
  const id = useId(), ref = useRef<HTMLDivElement>(null);
  useMenuOverlay(true);
  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  return createPortal(<MenuSemantics.Provider value={false}><div className="rb-dialog-cover" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={id} tabIndex={-1} className="rb-dialog" style={{ width }} onKeyDown={(e) => containKeys(e, onClose)}>
      <header className="rb-dialog-heading"><div><h2 id={id}>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button type="button" className="rb-icon-button" aria-label={`Close ${title.toLowerCase()}`} onClick={onClose}><X size={17}/></button></header>
      <div className="rb-dialog-body">{children}</div>
      <footer className="rb-dialog-footer">{footer}<button type="button" className={`rb-button${closeLabel === "Done" ? " rb-button-primary" : ""}`} style={closeLabel === "Cancel" ? { order: -1 } : undefined} onClick={onClose}>{closeLabel}</button></footer>
    </div>
  </div></MenuSemantics.Provider>, document.body);
}
