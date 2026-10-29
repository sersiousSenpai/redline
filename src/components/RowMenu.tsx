// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! A session row's ⋯ menu (board 4d): Open, Rename, Archive, then Delete on
//! its own below a rule, tinted so nobody has to hunt for it. The same menu
//! opens on right-click (at the pointer, like any context menu), from the
//! keyboard (⇧F10, the menu key) and from the ⋯ a row shows only while it is
//! hovered or focused (D37); ⌫ on a focused row skips it and asks to delete.
//!
//! Also the row's inline rename, so a renamed row never leaves its place.

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AppWindow, Archive, ArchiveRestore, Ellipsis, FileText, MessageSquare, Pencil, Trash2 } from "lucide-react";
import { useMenuOverlay } from "./menuOverlay";
import { MenuSurface } from "./ui/MenuSurface";

export interface RowAction {
  label: string;
  onSelect: () => void;
  /** A 14px glyph before the label. */
  icon?: ReactNode;
  /** The key that does this without the menu, shown at the right (⌫). */
  shortcut?: string;
  /** Tinted with the danger mode colours, always, not only on hover. */
  danger?: boolean;
  disabled?: boolean;
  /** A rule above this item: what follows is a different kind of act. */
  divided?: boolean;
}

const glyph = (Icon: typeof FileText) => <Icon size={14} aria-hidden />;

/** What a row's menu does with it. Each of rename, archive and delete is
 *  offered only when the host can do it. */
export interface RowActs {
  open: () => void;
  /** The session's own set, its Plan, Agent and Terminals tabs (D29): a row
   *  click opens the plan as a tab of the set on screen instead. */
  workspace?: () => void;
  rename?: () => void;
  archive?: () => void;
  remove?: () => void;
}

/** A plan session's menu. A held session cannot be archived: Claude is
 *  waiting on its review. */
export function planRowActions(session: { archivedAt?: number | null; held: boolean }, act: RowActs): RowAction[] {
  return [
    { label: "Open plan", icon: glyph(FileText), onSelect: act.open },
    ...(act.workspace ? [{ label: "Open as workspace", icon: glyph(AppWindow), onSelect: act.workspace }] : []),
    ...(act.rename ? [{ label: "Rename", icon: glyph(Pencil), onSelect: act.rename }] : []),
    ...(act.archive ? [{ label: session.archivedAt ? "Unarchive" : "Archive", icon: glyph(session.archivedAt ? ArchiveRestore : Archive), disabled: session.held, onSelect: act.archive }] : []),
    ...(act.remove ? [{ label: "Delete plan", icon: glyph(Trash2), shortcut: "⌫", danger: true, divided: true, onSelect: act.remove }] : []),
  ];
}

/** A chat's menu: the same acts, named for a chat. */
export function chatRowActions(chat: { archivedAt?: number | null }, act: RowActs): RowAction[] {
  return [
    { label: "Open chat", icon: glyph(MessageSquare), onSelect: act.open },
    ...(act.rename ? [{ label: "Rename", icon: glyph(Pencil), onSelect: act.rename }] : []),
    ...(act.archive ? [{ label: chat.archivedAt ? "Unarchive" : "Archive", icon: glyph(chat.archivedAt ? ArchiveRestore : Archive), onSelect: act.archive }] : []),
    ...(act.remove ? [{ label: "Delete chat", icon: glyph(Trash2), shortcut: "⌫", danger: true, divided: true, onSelect: act.remove }] : []),
  ];
}

/** Board 4d places the menu over the ⋯ it came from, up and to the left of
 *  it, so the row it acts on stays readable beside it: 7px left of the
 *  trigger box and 17px above it. */
const ANCHOR_DX = -7;
const ANCHOR_DY = -17;
/** Clearance kept from the window edges. */
const EDGE = 8;

export function RowMenu({
  open,
  onOpenChange,
  actions,
  label,
  at,
  trigger: shown = true,
  triggerClassName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actions: RowAction[];
  label: string;
  /** Where a right-click opened it. The ⋯ anchors it otherwise. */
  at?: { x: number; y: number } | null;
  /** Whether the ⋯ is out. An open menu keeps it, as its anchor and the
   *  place focus goes back to. */
  trigger?: boolean;
  triggerClassName: string;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useMenuOverlay(open);
  // Placed against its own measured size before the first paint, so it never
  // shows at a stale spot or past the window edge for a frame.
  useLayoutEffect(() => {
    const el = panel.current;
    if (!open || !el || !anchor.current) return;
    const r = anchor.current.getBoundingClientRect();
    const x = at ? at.x : r.left + ANCHOR_DX;
    const y = at ? at.y : r.top + ANCHOR_DY;
    el.style.left = `${Math.max(EDGE, Math.min(x, window.innerWidth - el.offsetWidth - EDGE))}px`;
    el.style.top = `${Math.max(EDGE, Math.min(y, window.innerHeight - el.offsetHeight - EDGE))}px`;
    el.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [open, at, actions.length]);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (!panel.current?.contains(e.target as Node) && !anchor.current?.contains(e.target as Node)) onOpenChange(false);
    };
    // A resize, or a scroll that carries what the menu points at away, would
    // leave it pointing at nothing. Only such a scroll: one of something
    // holding its ⋯, or, for a menu opened at a point (a right-click), of
    // something under that point. A terminal streaming beside the menu
    // scrolls its own viewport every line, and closed the pane menu before
    // it could be read (W5 walk, the two-wall tab).
    const moved = (e: Event) => {
      if (e.type === "resize") return onOpenChange(false);
      const target = e.target;
      if (target instanceof Node && panel.current?.contains(target)) return;
      if (!(target instanceof Element) || target === document.documentElement || target === document.body) return onOpenChange(false);
      if (at) {
        const r = target.getBoundingClientRect();
        if (at.x >= r.left && at.x <= r.right && at.y >= r.top && at.y <= r.bottom) onOpenChange(false);
      } else if (!anchor.current || target.contains(anchor.current)) onOpenChange(false);
    };
    document.addEventListener("pointerdown", close);
    window.addEventListener("resize", moved);
    window.addEventListener("scroll", moved, true);
    return () => {
      document.removeEventListener("pointerdown", close);
      window.removeEventListener("resize", moved);
      window.removeEventListener("scroll", moved, true);
    };
  }, [open, onOpenChange, at]);
  const dismiss = () => {
    onOpenChange(false);
    anchor.current?.focus();
  };
  return <>
    {(shown || open) && <button ref={anchor} type="button" className={triggerClassName} aria-label={`Actions for ${label}`} aria-haspopup="menu" aria-expanded={open}
      onClick={e => { e.stopPropagation(); onOpenChange(!open); }}>
      <Ellipsis size={14} aria-hidden />
    </button>}
    {open && createPortal(<div ref={panel} className="rl-row-menu-layer" onKeyDown={e => {
      // The menu is portalled, but React still bubbles its keys to the row
      // that rendered it, whose own ⌫ would act a second time.
      e.stopPropagation();
      const items = [...(panel.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      const go = (to: number) => { e.preventDefault(); items[(to + items.length) % items.length]?.focus(); };
      // Tab leaves the way it came, to the ⋯, rather than into whatever
      // follows the menu at the end of <body>.
      if (e.key === "Escape" || e.key === "Tab") { e.preventDefault(); dismiss(); }
      else if (e.key === "ArrowDown") go(index + 1);
      else if (e.key === "ArrowUp") go(index < 0 ? -1 : index - 1);
      else if (e.key === "Home") go(0);
      else if (e.key === "End") go(-1);
      else if (e.key === "Backspace" || e.key === "Delete") {
        // The key the menu itself advertises for Delete.
        const keyed = actions.find(action => action.shortcut === "⌫" && !action.disabled);
        if (keyed) { e.preventDefault(); dismiss(); keyed.onSelect(); }
      }
    }}><MenuSurface ariaLabel={`Actions for ${label}`} className="rl-row-menu" style={{ borderRadius: "var(--rl-radius-card)" }}>
      {actions.map(action => <RowMenuItem key={action.label} action={action} onPick={() => { dismiss(); action.onSelect(); }} />)}
    </MenuSurface></div>, document.body)}
  </>;
}

function RowMenuItem({ action, onPick }: { action: RowAction; onPick: () => void }) {
  return <>
    {action.divided && <div role="separator" className="rl-row-menu-rule" />}
    <button type="button" role="menuitem" disabled={action.disabled} data-danger={action.danger || undefined} className="rl-row-menu-item"
      onClick={e => { e.stopPropagation(); onPick(); }}>
      {action.icon}
      <span className="rl-row-menu-label">{action.label}</span>
      {action.shortcut && <kbd className="rl-row-menu-key" aria-hidden>{action.shortcut}</kbd>}
    </button>
  </>;
}

/** The row's own title, editable in place. Enter or leaving the field saves;
 *  Escape puts the old title back. `onDone` gets the new title, or null when
 *  nothing should be written (cancelled, or unchanged). */
export function RowRename({ value, label, className, onDone }: {
  value: string;
  label: string;
  className?: string;
  onDone: (title: string | null, how: "enter" | "escape" | "blur") => void;
}) {
  const [draft, setDraft] = useState(value);
  const input = useRef<HTMLInputElement>(null);
  // Enter and Escape unmount the field, and the blur that follows must not
  // write a second time.
  const done = useRef(false);
  useLayoutEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const finish = (how: "enter" | "escape" | "blur") => {
    if (done.current) return;
    done.current = true;
    const next = draft.trim();
    onDone(how === "escape" || next === value.trim() ? null : next, how);
  };
  return <input ref={input} className={className} aria-label={label} maxLength={200} value={draft} spellCheck={false}
    onChange={e => setDraft(e.target.value)}
    onClick={e => e.stopPropagation()}
    onBlur={() => finish("blur")}
    onKeyDown={e => {
      // The row's own keys (⌫ deletes, Enter opens) must not see typing.
      e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); finish("enter"); }
      else if (e.key === "Escape") { e.preventDefault(); finish("escape"); }
    }} />;
}
