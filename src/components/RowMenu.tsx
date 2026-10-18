// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useMenuOverlay } from "./menuOverlay";
import { MenuSurface } from "./ui/MenuSurface";

export interface RowAction { label: string; onSelect: () => void; danger?: boolean; disabled?: boolean }
export function RowMenu({ open, onOpenChange, actions, label }: {
  open: boolean; onOpenChange: (open: boolean) => void; actions: RowAction[]; label: string;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  useMenuOverlay(open);
  useLayoutEffect(() => {
    if (!open || !trigger.current) return;
    const r = trigger.current.getBoundingClientRect();
    setPosition({ left: Math.max(8, Math.min(r.right - 190, window.innerWidth - 198)), top: Math.max(8, Math.min(r.bottom + 4, window.innerHeight - actions.length * 32 - 24)) });
    panel.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [open, actions.length]);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (!panel.current?.contains(e.target as Node) && !trigger.current?.contains(e.target as Node)) onOpenChange(false);
    };
    document.addEventListener("pointerdown", close);
    window.addEventListener("resize", close);
    return () => { document.removeEventListener("pointerdown", close); window.removeEventListener("resize", close); };
  }, [open, onOpenChange]);
  return <>
    <button ref={trigger} type="button" className="rl-row-menu-trigger" aria-label={`Actions for ${label}`} aria-haspopup="menu" aria-expanded={open} onClick={e => { e.stopPropagation(); onOpenChange(!open); }}>⋯</button>
    {open && createPortal(<div ref={panel} style={{ position: "fixed", ...position, width: 190, zIndex: 1000 }} onKeyDown={e => {
      if (e.key === "Escape" || e.key === "Tab") { onOpenChange(false); if (e.key === "Escape") { e.preventDefault(); trigger.current?.focus(); } }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const items = [...(panel.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
        const at = items.indexOf(document.activeElement as HTMLButtonElement);
        items[(at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
      }
    }}><MenuSurface ariaLabel={`Actions for ${label}`} className="rl-row-menu">
      {actions.map(action => <button key={action.label} type="button" role="menuitem" disabled={action.disabled} className={`rl-menu-item${action.danger ? " rl-row-danger" : ""}`} onClick={e => { e.stopPropagation(); onOpenChange(false); trigger.current?.focus(); action.onSelect(); }}>{action.label}</button>)}
    </MenuSurface></div>, document.body)}
  </>;
}
