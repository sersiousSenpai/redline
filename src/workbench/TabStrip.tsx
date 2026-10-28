// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// The Workbench tab strip (W1): the 34px row over the stage that names the
// set's tabs. Pure and presentational — App / WorkbenchStage hands it the
// items, which tab is active and what each act does; it owns only its own
// transient states (a drag, an open context menu, an inline rename).
//
// One status vocabulary (status.ts): needs you is the amber `.rl-wb-dot`
// breathing its opacity, working is the shared HTML `Spinner`, idle shows
// nothing, exited mutes the tab. Reorder is pointer events on the tab
// buttons, not HTML5 drag-and-drop, which the Tauri webview drops on the
// floor. The context menu and the rename are the sidebar's `RowMenu` and
// `RowRename`, so a tab and a session row behave alike.
//
// Each tab row is memoized with id-based handlers from one `useMemo`'d
// object, so a status tick on one tab re-renders one tab.

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type JSX,
  type ReactNode,
} from "react";
import {
  ArrowLeft,
  ArrowRight,
  Brain,
  CircleX,
  DoorOpen,
  FileCode,
  FilePenLine,
  GitCompare,
  Globe,
  MessageSquare,
  PenLine,
  Pencil,
  Plus,
  RotateCcw,
  Server,
  Terminal,
  X,
  type LucideIcon,
} from "lucide-react";
import { Spinner } from "../components/Spinner";
import { RowMenu, RowRename, type RowAction } from "../components/RowMenu";
import type { PaneKind } from "./model";
import type { PaneStatus } from "./status";
import "./workbench.css";

export interface TabStripItem {
  id: string;
  /** Picks the 16px lucide glyph. */
  kind: PaneKind;
  title: string;
  status?: PaneStatus;
  /** A preview pane: the title is set in italics. */
  preview?: boolean;
  /** A small muted number after the title (a wall's tile count). */
  count?: number;
}

export interface TabStripProps {
  tabs: readonly TabStripItem[];
  activeTabId: string | null;
  onSelect(id: string): void;
  onClose(id: string): void;
  /** Drag reorder. `to` is the index the tab takes once it is lifted out of
   *  `tabs` — the reducer's `reorderTab` splice position. */
  onReorder(id: string, to: number): void;
  /** Double-click or F2 → inline rename. Never called with an empty title. */
  onRename(id: string, title: string): void;
  /** The + cell (⌘T). */
  onNew(): void;
  /** Offered in the context menu while `canReopen`. */
  onReopen?(): void;
  canReopen?: boolean;
  /** The right-hand cluster: the stage's pane actions. */
  right?: ReactNode;
}

/** The glyph per pane kind. */
export const TAB_ICONS: Record<PaneKind, LucideIcon> = {
  door: DoorOpen,
  plan: FilePenLine,
  chat: MessageSquare,
  terminals: Terminal,
  file: FileCode,
  browser: Globe,
  drafter: PenLine,
  review: GitCompare,
  servers: Server,
  memory: Brain,
};

/** Pointer travel before a press becomes a drag. */
export const DRAG_SLOP = 4;

interface Handlers {
  select(id: string): void;
  close(id: string): void;
  rename(id: string): void;
  renameDone(id: string, title: string | null, how: "enter" | "escape" | "blur"): void;
  menu(id: string, at: { x: number; y: number }): void;
  key(id: string, e: ReactKeyboardEvent<HTMLButtonElement>): void;
  pointerDown(id: string, e: ReactPointerEvent<HTMLButtonElement>): void;
  click(id: string, e: ReactMouseEvent<HTMLButtonElement>): void;
}

const glyph = (Icon: LucideIcon) => <Icon size={14} aria-hidden />;

// ── One tab ────────────────────────────────────────────────────────────────

function TabRowBase({
  tab,
  active,
  dragging,
  renaming,
  h,
}: {
  tab: TabStripItem;
  active: boolean;
  dragging: boolean;
  renaming: boolean;
  h: Handlers;
}) {
  const Icon = TAB_ICONS[tab.kind] ?? FileCode;
  const status = tab.status;
  return (
    <button
      type="button"
      role="tab"
      className="rl-wb-tab"
      data-tab-id={tab.id}
      data-status={status === "exited" ? "exited" : undefined}
      data-preview={tab.preview || undefined}
      data-dragging={dragging || undefined}
      aria-selected={active}
      aria-current={active || undefined}
      tabIndex={active ? 0 : -1}
      title={tab.title}
      onClick={(e) => h.click(tab.id, e)}
      onAuxClick={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          h.close(tab.id);
        }
      }}
      onMouseDown={(e) => {
        // The middle button's autoscroll would fight the strip.
        if (e.button === 1) e.preventDefault();
      }}
      onDoubleClick={(e) => {
        e.preventDefault();
        h.rename(tab.id);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        h.menu(tab.id, { x: e.clientX, y: e.clientY });
      }}
      onKeyDown={(e) => h.key(tab.id, e)}
      onPointerDown={(e) => h.pointerDown(tab.id, e)}
    >
      <Icon size={16} className="rl-wb-icon" aria-hidden />
      {renaming ? (
        <RowRename
          className="rl-wb-rename"
          label={`Rename ${tab.title}`}
          value={tab.title}
          onDone={(title, how) => h.renameDone(tab.id, title, how)}
        />
      ) : (
        <span className="rl-wb-title">{tab.title}</span>
      )}
      {tab.count != null && <span className="rl-wb-count">{tab.count}</span>}
      {status === "needs" && <i className="rl-wb-dot" data-status="needs" aria-hidden />}
      {status === "working" && <Spinner size={10} />}
      <span
        role="button"
        tabIndex={-1}
        className="rl-wb-tab-x"
        aria-label={`Close ${tab.title}`}
        title="Close"
        onClick={(e) => {
          e.stopPropagation();
          h.close(tab.id);
        }}
        onPointerDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <X size={12} aria-hidden />
      </span>
    </button>
  );
}

const TabRow = memo(TabRowBase);

// ── The strip ──────────────────────────────────────────────────────────────

interface DragState {
  id: string;
  /** The splice index the tab would take. */
  to: number;
  /** The indicator's x within the tab list's scroll content. */
  x: number;
}

interface Press {
  id: string;
  startX: number;
  pointerId: number;
  el: HTMLButtonElement;
  /** Set once the press has travelled past DRAG_SLOP. */
  dragging: boolean;
  /** Slots measured on the first real move: each other tab's rect. */
  slots: { left: number; right: number; center: number }[] | null;
  to: number;
}

export function TabStrip(props: TabStripProps): JSX.Element {
  const { tabs, activeTabId, onNew, right } = props;
  const list = useRef<HTMLDivElement>(null);
  // The latest props for the stable handlers, so a memoized row never holds a
  // stale callback.
  const latest = useRef(props);
  useLayoutEffect(() => {
    latest.current = props;
  });

  const [drag, setDrag] = useState<DragState | null>(null);
  const [menu, setMenu] = useState<{ id: string; at: { x: number; y: number } } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const press = useRef<Press | null>(null);
  // The tab whose drag just ended: the click that lands after its pointerup
  // is not a select.
  const swallowClick = useRef<string | null>(null);
  // Where focus returns after the menu closes or a rename ends.
  const refocus = useRef<string | null>(null);
  // Ends a press in flight (unmount mid-drag), set by the handlers below.
  const abort = useRef<() => void>(() => {});

  const tabButton = useCallback((id: string): HTMLButtonElement | null => {
    const root = list.current;
    if (!root) return null;
    for (const el of root.querySelectorAll<HTMLButtonElement>('[role="tab"]')) {
      if (el.dataset.tabId === id) return el;
    }
    return null;
  }, []);

  const focusTab = useCallback(
    (id: string) => {
      tabButton(id)?.focus();
    },
    [tabButton],
  );

  useEffect(() => {
    if (menu || renaming) return;
    const id = refocus.current;
    if (!id) return;
    refocus.current = null;
    focusTab(id);
  }, [menu, renaming, focusTab]);

  const h = useMemo<Handlers>(() => {
    const endPress = (commit: boolean, clientX: number) => {
      const p = press.current;
      if (!p) return;
      press.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      try {
        if (p.el.hasPointerCapture?.(p.pointerId)) p.el.releasePointerCapture(p.pointerId);
      } catch {
        /* a pointer the element never captured */
      }
      if (!p.dragging) return;
      // The click that follows this pointerup is the drag's, not a select.
      // Remembered by tab and cleared by the next press, so a drag let go off
      // the tab (no click follows) never eats a later real click.
      swallowClick.current = p.id;
      setDrag(null);
      if (!commit) return;
      const to = targetOf(p, clientX);
      const { tabs: items, onReorder } = latest.current;
      const from = items.findIndex((t) => t.id === p.id);
      if (to !== from) onReorder(p.id, to);
    };
    const measure = (p: Press) => {
      const root = list.current;
      if (!root) return [];
      const slots: Press["slots"] = [];
      for (const el of root.querySelectorAll<HTMLButtonElement>('[role="tab"]')) {
        if (el.dataset.tabId === p.id) continue;
        const r = el.getBoundingClientRect();
        slots.push({ left: r.left, right: r.right, center: (r.left + r.right) / 2 });
      }
      return slots;
    };
    const targetOf = (p: Press, clientX: number): number => {
      const slots = p.slots ?? [];
      let to = 0;
      for (const s of slots) if (s.center < clientX) to++;
      return to;
    };
    const indicatorX = (p: Press, to: number): number => {
      const slots = p.slots ?? [];
      const root = list.current;
      const base = root ? root.getBoundingClientRect().left - root.scrollLeft : 0;
      if (slots.length === 0) return 0;
      const edge = to < slots.length ? slots[to].left : slots[slots.length - 1].right;
      return edge - base;
    };
    const onMove = (e: PointerEvent) => {
      const p = press.current;
      if (!p || e.pointerId !== p.pointerId) return;
      if (!p.dragging) {
        if (Math.abs(e.clientX - p.startX) < DRAG_SLOP) return;
        p.dragging = true;
        p.slots = measure(p);
      }
      const to = targetOf(p, e.clientX);
      p.to = to;
      setDrag({ id: p.id, to, x: indicatorX(p, to) });
    };
    const onUp = (e: PointerEvent) => {
      if (press.current && e.pointerId === press.current.pointerId) endPress(true, e.clientX);
    };
    const onCancel = (e: PointerEvent) => {
      if (press.current && e.pointerId === press.current.pointerId) endPress(false, e.clientX);
    };
    abort.current = () => endPress(false, 0);

    return {
      select: (id) => latest.current.onSelect(id),
      close: (id) => latest.current.onClose(id),
      rename: (id) => {
        refocus.current = id;
        setRenaming(id);
      },
      renameDone: (id, title, how) => {
        setRenaming((cur) => (cur === id ? null : cur));
        if (how === "blur") refocus.current = null;
        if (title) latest.current.onRename(id, title);
      },
      menu: (id, at) => {
        refocus.current = id;
        setMenu({ id, at });
      },
      click: (id, e) => {
        if (swallowClick.current === id) {
          swallowClick.current = null;
          e.preventDefault();
          return;
        }
        latest.current.onSelect(id);
      },
      key: (id, e) => {
        const { tabs: items, onSelect, onClose } = latest.current;
        const index = items.findIndex((t) => t.id === id);
        const go = (next: number) => {
          const target = items[next];
          if (!target) return;
          e.preventDefault();
          onSelect(target.id);
          focusTab(target.id);
        };
        switch (e.key) {
          case "ArrowLeft":
            go(index - 1);
            break;
          case "ArrowRight":
            go(index + 1);
            break;
          case "Home":
            go(0);
            break;
          case "End":
            go(items.length - 1);
            break;
          case "Enter":
          case " ":
            e.preventDefault();
            onSelect(id);
            break;
          case "Delete":
          case "Backspace":
            e.preventDefault();
            onClose(id);
            break;
          case "F2":
            e.preventDefault();
            refocus.current = id;
            setRenaming(id);
            break;
          case "ContextMenu": {
            e.preventDefault();
            const r = e.currentTarget.getBoundingClientRect();
            refocus.current = id;
            setMenu({ id, at: { x: r.left + 12, y: r.bottom } });
            break;
          }
          default:
            return;
        }
      },
      pointerDown: (id, e) => {
        if (e.button !== 0 || press.current) return;
        swallowClick.current = null;
        if ((e.target as Element).closest?.(".rl-wb-tab-x, .rl-wb-rename")) return;
        const el = e.currentTarget;
        press.current = { id, startX: e.clientX, pointerId: e.pointerId, el, dragging: false, slots: null, to: 0 };
        try {
          el.setPointerCapture?.(e.pointerId);
        } catch {
          /* jsdom, or a pointer already captured elsewhere */
        }
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
        window.addEventListener("pointercancel", onCancel);
      },
    };
  }, [focusTab]);

  // A strip unmounting mid-drag leaves no window listeners behind.
  useEffect(() => () => abort.current(), []);

  const menuTab = menu ? tabs.find((t) => t.id === menu.id) ?? null : null;
  const menuActions = useMemo<RowAction[]>(() => {
    if (!menuTab) return [];
    const { tabs: items, onClose, onReorder, canReopen, onReopen } = latest.current;
    const index = items.findIndex((t) => t.id === menuTab.id);
    const actions: RowAction[] = [
      { label: "Close", icon: glyph(X), shortcut: "⌫", onSelect: () => onClose(menuTab.id) },
    ];
    if (items.length > 1) {
      actions.push({
        label: "Close others",
        icon: glyph(CircleX),
        onSelect: () => {
          for (const t of items) if (t.id !== menuTab.id) onClose(t.id);
        },
      });
    }
    actions.push({
      label: "Rename",
      icon: glyph(Pencil),
      onSelect: () => {
        refocus.current = menuTab.id;
        setRenaming(menuTab.id);
      },
    });
    if (canReopen && onReopen) {
      actions.push({ label: "Reopen closed tab", icon: glyph(RotateCcw), onSelect: () => onReopen() });
    }
    actions.push(
      {
        label: "Move left",
        icon: glyph(ArrowLeft),
        divided: true,
        disabled: index <= 0,
        onSelect: () => onReorder(menuTab.id, index - 1),
      },
      {
        label: "Move right",
        icon: glyph(ArrowRight),
        disabled: index < 0 || index >= items.length - 1,
        onSelect: () => onReorder(menuTab.id, index + 1),
      },
    );
    return actions;
    // The actions read the latest props when picked; only the target tab and
    // the list's shape change what is offered.
  }, [menuTab, tabs.length, props.canReopen, props.onReopen]);

  const onMenuOpen = useCallback((open: boolean) => {
    if (!open) setMenu(null);
  }, []);

  return (
    <div className="rl-wb-strip">
      <div ref={list} className="rl-wb-tablist rl-thin-scroll-x" role="tablist" aria-label="Tabs">
        {tabs.map((tab) => (
          <TabRow
            key={tab.id}
            tab={tab}
            active={tab.id === activeTabId}
            dragging={drag?.id === tab.id}
            renaming={renaming === tab.id}
            h={h}
          />
        ))}
        {drag && <span className="rl-wb-drop" aria-hidden style={{ left: drag.x }} />}
      </div>
      <button type="button" className="rl-wb-new" aria-label="New tab" title="New tab (⌘T)" onClick={() => onNew()}>
        <Plus size={16} aria-hidden />
      </button>
      <div className="rl-wb-spacer" />
      {right != null && <div className="rl-wb-right">{right}</div>}
      <RowMenu
        open={menu !== null && menuTab !== null}
        onOpenChange={onMenuOpen}
        at={menu?.at ?? null}
        actions={menuActions}
        label={menuTab?.title ?? "tab"}
        triggerClassName="rl-wb-menu-anchor"
      />
    </div>
  );
}

export default TabStrip;
