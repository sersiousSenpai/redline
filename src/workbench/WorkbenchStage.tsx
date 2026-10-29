// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// The centre of the window under the workbench: the active set's tab strip
// and, below it, the active tab's panes — a pane, or the one split the app
// makes today (a document-family pane beside a surface, the tile; D24), laid
// out from the tab's `LayoutNode` tree with the divider below. App hands in
// `renderPane`, which dispatches a pane to its body in `./panes/*`, so this
// file knows kinds and layout and nothing about what a plan is.
//
// Kept tabs: the active tab and the three most recently shown stay mounted.
// A hidden kept tab is `inert` and skips layout and paint (styles.css), so its
// webviews, editors and terminals keep their state without laying out or
// painting, and switching back mounts nothing. Visibility reaches panes
// through `useDeferredValue`, so the strip and the tab paint before any
// pane reacts to being shown (a native webview coming forward, a review
// poll resuming). Singleton bodies never mount inside a tab — only their
// slots do (`SingletonSlot`).

import { lazy, memo, Suspense, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Columns2, Equal, Maximize2, Minimize2, Rows2, SquareArrowOutUpRight, X } from "lucide-react";

import { ErrorBoundary } from "../components/ErrorBoundary";
import { RowMenu, type RowAction } from "../components/RowMenu";
import { rafCoalesce } from "../lib/raf";
import { beginResizeSession, endResizeSession } from "../lib/resizeSession";
import { activeTabOf, isSplit, normalizeWeights, paneIdsOf, paneTitle, type AnyPane, type LayoutNode, type Tab, type TabSet } from "./model";
import { focusPaneKeyOf, isEqualizeKey } from "../lib/keymap";
import { dropTargetAt, paneBoxes, type DropTarget } from "./drop";
import { MIN_SPLIT_SHARE } from "./reducer";
import { beginMeasure, endMeasure } from "./perf";
import type { PaneStatus } from "./status";
import { useWorkbench, type WorkbenchStore } from "./store";
import type { TabStripItem } from "./TabStrip";

/** Lazy, with a null fallback and warmed as this module evaluates: the strip
 *  is the first thing a tab switch paints, and nothing on the boot path
 *  needs its drag, rename and menu code before the first frame. */
const loadTabStrip = () => import("./TabStrip");
const TabStrip = lazy(() => loadTabStrip().then((m) => ({ default: m.TabStrip })));
if (typeof window !== "undefined") void loadTabStrip().catch(() => {});

/** How many tabs beyond the active one stay mounted. */
export const KEPT_TABS = 3;

export interface PaneContext {
  /** The pane is in the active tab, after the deferred frame: the pane's
   *  own "am I on screen" (the browser's native show, a review's polls). */
  visible: boolean;
  /** The pane is the tab's focused pane. */
  focused: boolean;
  /** The pane's tab is the active tab (undeferred: the DOM's view). */
  active: boolean;
}

/** What App says about a pane beyond its kind: a richer title (the plan's
 *  heading), a status in the shared vocabulary, a small count. */
export interface PaneDescription {
  title?: string;
  status?: PaneStatus;
  count?: number;
}

export interface WorkbenchStageProps {
  store: WorkbenchStore;
  renderPane: (pane: AnyPane, ctx: PaneContext) => ReactNode;
  describePane?: (pane: AnyPane) => PaneDescription;
  /** Fired on split-divider drag start/end (the browser hides meanwhile). */
  onSplitDragging?: (dragging: boolean) => void;
  /** The strip's right-hand cluster. */
  right?: ReactNode;
  /** ⌘T: App opens the door tab (it knows the active pane's destination). */
  onNewTab: () => void;
  /** A tab's ×: App closes it (it asks first when a wall in it is still
   *  running). Absent, the tab just closes. */
  onCloseTab?: (tabId: string) => void;
  /** The pane menu's Split right / down: App splits the focused pane with a
   *  door (it mints the door's draft), as ⌘D / ⌘⇧D. Absent, no split rows. */
  onSplit?: (direction: "row" | "column") => void;
  /** The pane menu's Close pane: App closes it (asking for a running wall).
   *  Absent, the pane just closes. */
  onClosePane?: (paneId: string) => void;
}

const selectSet = (s: ReturnType<WorkbenchStore["getState"]>): TabSet | null => s.sets[s.activeKey] ?? null;
const selectKey = (s: ReturnType<WorkbenchStore["getState"]>) => s.activeKey;

export function WorkbenchStage({ store, renderPane, describePane, onSplitDragging, right, onNewTab, onCloseTab, onSplit, onClosePane }: WorkbenchStageProps) {
  const set = useWorkbench(store, selectSet);
  const activeKey = useWorkbench(store, selectKey);
  const activeTabId = set?.activeTabId ?? null;
  // The tab whose panes count as visible: one deferred frame behind the
  // DOM, so a switch paints before the panes react to it.
  const visibleTabId = useDeferredValue(activeTabId);

  // Kept tabs, most recently shown first, per set.
  const keptRef = useRef(new Map<string, string[]>());
  const kept = useMemo(() => {
    if (!set) return [] as string[];
    const list = keptRef.current.get(activeKey) ?? [];
    const next = activeTabId ? [activeTabId, ...list.filter((id) => id !== activeTabId && set.tabs[id])] : list.filter((id) => set.tabs[id]);
    const trimmed = next.slice(0, KEPT_TABS + 1);
    keptRef.current.set(activeKey, trimmed);
    return trimmed;
  }, [set, activeKey, activeTabId]);

  const dispatch = store.dispatch;
  const onSelect = useCallback((tabId: string) => {
    beginMeasure("wb:tab-switch");
    dispatch({ type: "selectTab", tabId });
  }, [dispatch]);
  const onClose = useCallback((tabId: string) => (onCloseTab ? onCloseTab(tabId) : dispatch({ type: "closeTab", tabId })), [dispatch, onCloseTab]);
  const onReorder = useCallback((tabId: string, to: number) => dispatch({ type: "reorderTab", tabId, to }), [dispatch]);
  const onReopen = useCallback(() => dispatch({ type: "reopenClosed" }), [dispatch]);
  const onRename = useCallback(
    (tabId: string, title: string) => {
      const s = store.getState();
      const current = s.sets[s.activeKey];
      const tab = current?.tabs[tabId];
      if (!current || !tab) return;
      dispatch({ type: "renamePane", paneId: tab.focusedPaneId, title });
    },
    [dispatch, store],
  );
  const onFocusPane = useCallback((paneId: string) => dispatch({ type: "focusPane", paneId }), [dispatch]);
  const onMoveToNewTab = useCallback(
    (tabId: string) => {
      const s = store.getState();
      const tab = s.sets[s.activeKey]?.tabs[tabId];
      if (tab) dispatch({ type: "movePaneToTab", paneId: tab.focusedPaneId });
    },
    [dispatch, store],
  );
  const onMerge = useCallback(
    (tabId: string, dir: -1 | 1) => {
      const s = store.getState();
      const order = s.sets[s.activeKey]?.order ?? [];
      const into = order[order.indexOf(tabId) + dir];
      // Into the tab on its left it lands on that tab's right, and the
      // other way: the strip's order, read across the split.
      if (into) dispatch({ type: "mergeTab", tabId, intoTabId: into, edge: dir < 0 ? "right" : "left" });
    },
    [dispatch, store],
  );

  // Merge by drag: a tab dragged down out of the strip lights the half of
  // the pane under it that it would take; let go there, it merges. The tab
  // in front cannot merge into itself. While a tab hangs over the stage the
  // webviews show their snapshots (a resize session), so the page under the
  // pointer is the DOM's and the drop zone paints over it.
  const tabsRef = useRef<HTMLDivElement | null>(null);
  const [drop, setDrop] = useState<{ tabId: string; target: DropTarget } | null>(null);
  const dragSession = useRef(false);
  const endDragSession = useCallback(() => {
    if (!dragSession.current) return;
    dragSession.current = false;
    endResizeSession();
  }, []);
  useEffect(() => endDragSession, [endDragSession]);

  // ⌃⌘ + an arrow: the pane that way ON SCREEN (the rendered boxes, not the
  // tree: a column beside a row has more than one neighbour a tree walk
  // could pick). ⌘⌥= evens every split of the tab. Capture phase, ahead of
  // xterm's arrows; a lone pane leaves the keys alone. The stage's own keys,
  // so they ride its chunk, not the boot path.
  useEffect(() => {
    const onPaneKey = (e: KeyboardEvent) => {
      const dir = focusPaneKeyOf(e);
      const even = !dir && isEqualizeKey(e);
      if (!dir && !even) return;
      const s = store.getState();
      const current = s.sets[s.activeKey];
      const tab = current ? activeTabOf(current) : null;
      if (!tab || !isSplit(tab.root)) return;
      e.preventDefault();
      e.stopPropagation();
      if (dir) dispatch({ type: "focusPane", dir, rects: paneBoxes(tabsRef.current, tab.id) });
      else dispatch({ type: "equalize" });
    };
    // The same chords pressed in a web page, forwarded (browser_signals.js →
    // BrowserPane's `redline:pane-key`).
    const fromPage = (e: Event) => {
      const value = (e as CustomEvent<string>).detail;
      const dir = value === "focus-left" ? "left" : value === "focus-right" ? "right" : value === "focus-up" ? "up" : value === "focus-down" ? "down" : null;
      if (!dir && value !== "equalize") return;
      const s = store.getState();
      const current = s.sets[s.activeKey];
      const tab = current ? activeTabOf(current) : null;
      if (!tab || !isSplit(tab.root)) return;
      if (dir) dispatch({ type: "focusPane", dir, rects: paneBoxes(tabsRef.current, tab.id) });
      else dispatch({ type: "equalize" });
    };
    window.addEventListener("keydown", onPaneKey, true);
    window.addEventListener("redline:pane-key", fromPage);
    return () => {
      window.removeEventListener("keydown", onPaneKey, true);
      window.removeEventListener("redline:pane-key", fromPage);
    };
  }, [dispatch, store]);
  const targetAt = useCallback(
    (tabId: string, at: { x: number; y: number }): DropTarget | null => {
      const s = store.getState();
      const current = s.sets[s.activeKey];
      if (!current?.activeTabId || current.activeTabId === tabId) return null;
      return dropTargetAt(paneBoxes(tabsRef.current, current.activeTabId, true), at.x, at.y);
    },
    [store],
  );
  const onDragOut = useCallback(
    (tabId: string, at: { x: number; y: number } | null) => {
      if (!at) {
        endDragSession();
        setDrop(null);
        return;
      }
      if (!dragSession.current) {
        dragSession.current = true;
        beginResizeSession();
      }
      const target = targetAt(tabId, at);
      if (!target) {
        setDrop(null);
        return;
      }
      setDrop((prev) =>
        prev && prev.tabId === tabId && prev.target.paneId === target.paneId && prev.target.edge === target.edge && prev.target.zone.width === target.zone.width && prev.target.zone.height === target.zone.height ? prev : { tabId, target },
      );
    },
    [endDragSession, targetAt],
  );
  const onDropOut = useCallback(
    (tabId: string, at: { x: number; y: number }) => {
      const target = targetAt(tabId, at);
      endDragSession();
      setDrop(null);
      if (target) dispatch({ type: "mergeTab", tabId, paneId: target.paneId, edge: target.edge });
    },
    [dispatch, endDragSession, targetAt],
  );
  const onResize = useCallback((tabId: string, path: number[], weights: number[]) => dispatch({ type: "resizeSplit", tabId, path, weights }), [dispatch]);

  const tabs: TabStripItem[] = useMemo(() => {
    if (!set) return [];
    // The tour's anchors: the first Agent and terminals tab.
    const toured = new Set<string>();
    const tourOf = (pane: AnyPane): string | undefined => {
      const id = pane.kind === "terminals" ? "terminals-tab" : pane.kind === "chat" && pane.data.source === "agent" ? "agent-tab" : undefined;
      if (!id || toured.has(id)) return undefined;
      toured.add(id);
      return id;
    };
    return set.order.flatMap((id) => {
      const tab = set.tabs[id];
      if (!tab) return [];
      const panes = paneIdsOf(tab.root).map((p) => set.panes[p]).filter((p): p is AnyPane => Boolean(p));
      // The tab wears its focused pane's identity, and the worst status of
      // all its panes.
      const lead = set.panes[tab.focusedPaneId] ?? panes[0];
      if (!lead) return [];
      const described = panes.map((p) => describePane?.(p) ?? {});
      const statuses = described.map((d) => d.status).filter((s): s is PaneStatus => Boolean(s));
      const status: PaneStatus | undefined = statuses.includes("needs") ? "needs" : statuses.includes("working") ? "working" : statuses.length && statuses.every((s) => s === "exited") ? "exited" : undefined;
      const leadIndex = Math.max(0, panes.indexOf(lead));
      const item: TabStripItem = { id, kind: lead.kind, title: described[leadIndex]?.title ?? paneTitle(lead), status, preview: lead.preview, count: described[leadIndex]?.count, tour: tourOf(lead), split: isSplit(tab.root) };
      return [item];
    });
  }, [set, describePane]);

  if (!set) return <div className="rl-wb-stage" />;
  return (
    <div className="rl-wb-stage" data-wb-key={activeKey}>
      <Suspense fallback={<div className="rl-wb-strip" aria-hidden />}>
        <TabStrip
          tabs={tabs}
          activeTabId={activeTabId}
          onSelect={onSelect}
          onClose={onClose}
          onReorder={onReorder}
          onRename={onRename}
          onNew={onNewTab}
          onReopen={onReopen}
          canReopen={set.closed.length > 0}
          onDragOut={onDragOut}
          onDropOut={onDropOut}
          onMoveToNewTab={onMoveToNewTab}
          onMerge={onMerge}
          right={
            <>
              {right}
              <PaneMenu store={store} onSplit={onSplit} onClosePane={onClosePane} />
            </>
          }
        />
      </Suspense>
      <div className="rl-wb-tabs" ref={tabsRef}>
        {kept.map((tabId) => {
          const tab = set.tabs[tabId];
          if (!tab) return null;
          const active = tabId === activeTabId;
          return (
            <TabBody
              key={`${activeKey}:${tabId}`}
              tab={tab}
              panes={set.panes}
              active={active}
              visible={active && tabId === visibleTabId}
              renderPane={renderPane}
              onFocusPane={onFocusPane}
              onResize={onResize}
              onSplitDragging={onSplitDragging}
            />
          );
        })}
        {/* On the body, fixed: over the terminal layer and any webview
            snapshot, whatever stacking context the stage sits in. */}
        {drop &&
          createPortal(
            <div
              className="rl-wb-drop-zone"
              data-drop-edge={drop.target.edge}
              data-drop-pane={drop.target.paneId}
              aria-hidden
              style={{ left: drop.target.zone.left, top: drop.target.zone.top, width: drop.target.zone.width, height: drop.target.zone.height }}
            />,
            document.body,
          )}
      </div>
    </div>
  );
}

const selectFocusedTab = (s: ReturnType<WorkbenchStore["getState"]>) => {
  const set = s.sets[s.activeKey];
  return set ? activeTabOf(set) : null;
};

/** The strip's ⋯ (the design's pane menu): what can be done to the focused
 *  pane — split it, zoom it, even out the tab, move it to a tab of its own,
 *  close it. Each row names its key. */
function PaneMenu({ store, onSplit, onClosePane }: { store: WorkbenchStore; onSplit?: (direction: "row" | "column") => void; onClosePane?: (paneId: string) => void }) {
  const tab = useWorkbench(store, selectFocusedTab);
  const [open, setOpen] = useState(false);
  const actions = useMemo<RowAction[]>(() => {
    if (!tab) return [];
    const split = isSplit(tab.root);
    const paneId = tab.focusedPaneId;
    const out: RowAction[] = [];
    if (onSplit) {
      out.push(
        { label: "Split right", icon: <Columns2 size={14} aria-hidden />, shortcut: "⌘D", onSelect: () => onSplit("row") },
        { label: "Split down", icon: <Rows2 size={14} aria-hidden />, shortcut: "⌘⇧D", onSelect: () => onSplit("column") },
      );
    }
    if (split) {
      out.push(
        { label: tab.zoomed ? "Put the tab back" : "Zoom the pane", icon: tab.zoomed ? <Minimize2 size={14} aria-hidden /> : <Maximize2 size={14} aria-hidden />, shortcut: "⌘⇧↩", divided: out.length > 0, onSelect: () => store.dispatch({ type: "zoomPane" }) },
        { label: "Even out the splits", icon: <Equal size={14} aria-hidden />, shortcut: "⌘⌥=", onSelect: () => store.dispatch({ type: "equalize" }) },
        { label: "Move to a new tab", icon: <SquareArrowOutUpRight size={14} aria-hidden />, divided: true, onSelect: () => store.dispatch({ type: "movePaneToTab", paneId }) },
        { label: "Close pane", icon: <X size={14} aria-hidden />, onSelect: () => (onClosePane ? onClosePane(paneId) : store.dispatch({ type: "closePane", paneId })) },
      );
    }
    return out;
  }, [tab, onSplit, onClosePane, store]);
  if (!tab || actions.length === 0) return null;
  return <RowMenu open={open} onOpenChange={setOpen} actions={actions} label="the pane" triggerClassName="rl-wb-right-btn rl-wb-pane-menu" />;
}

const TabBody = memo(function TabBody({ tab, panes, active, visible, renderPane, onFocusPane, onResize, onSplitDragging }: {
  tab: Tab;
  panes: Record<string, AnyPane>;
  active: boolean;
  visible: boolean;
  renderPane: (pane: AnyPane, ctx: PaneContext) => ReactNode;
  onFocusPane: (paneId: string) => void;
  onResize: (tabId: string, path: number[], weights: number[]) => void;
  onSplitDragging?: (dragging: boolean) => void;
}) {
  // `wb:tab-switch` ends when THIS tab's panes have committed as the active
  // ones and the next frame has painted them — the pane's paint, not the
  // strip's.
  useLayoutEffect(() => {
    if (!active) return;
    const frame = requestAnimationFrame(() => endMeasure("wb:tab-switch"));
    return () => cancelAnimationFrame(frame);
  }, [active]);
  // Focus follows the tab. `inert` keeps a hidden tab from TAKING focus but
  // does not move a focus it already holds, so a door left focused in a tab
  // just hidden went on swallowing typing meant elsewhere (a tile's ▾ menu):
  // hiding blurs whatever inside had it. Shown, the tab's focused pane
  // takes the caret — unless something live already has it (a terminal the
  // wall just focused, a field the user is in), so this never steals.
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const shownOnce = useRef(false);
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    if (!active) {
      const held = document.activeElement;
      if (held instanceof HTMLElement && body.contains(held)) held.blur();
      return;
    }
    // The first show is boot or a new tab, whose bodies place their own
    // caret (the door's box on ⌘T).
    if (!shownOnce.current) {
      shownOnce.current = true;
      return;
    }
    const frame = requestAnimationFrame(() => {
      const held = document.activeElement;
      // An element no longer drawn (inside a layer gone display:none, like a
      // hidden terminal's textarea) is a stray caret too.
      const stray = !held || held === document.body || !!held.closest("[inert], [data-hidden]") || undrawn(held);
      if (!stray) return;
      body.querySelector<HTMLElement>(".rl-wb-pane[data-focused]")?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [active]);
  return (
    <div
      ref={bodyRef}
      className="rl-wb-tab-body"
      data-hidden={active ? undefined : ""}
      // `inert` keeps a hidden kept tab out of focus and the accessibility
      // tree; React 19 forwards the boolean.
      inert={!active}
      role="tabpanel"
      data-wb-tab={tab.id}
      data-zoomed={tab.zoomed ? "" : undefined}
    >
      <LayoutView node={tab.root} path={[]} tab={tab} panes={panes} active={active} visible={visible} renderPane={renderPane} onFocusPane={onFocusPane} onResize={onResize} onSplitDragging={onSplitDragging} />
    </div>
  );
});

function LayoutView({ node, path, tab, panes, active, visible, renderPane, onFocusPane, onResize, onSplitDragging }: {
  node: LayoutNode;
  path: number[];
  tab: Tab;
  panes: Record<string, AnyPane>;
  active: boolean;
  visible: boolean;
  renderPane: (pane: AnyPane, ctx: PaneContext) => ReactNode;
  onFocusPane: (paneId: string) => void;
  onResize: (tabId: string, path: number[], weights: number[]) => void;
  onSplitDragging?: (dragging: boolean) => void;
}) {
  if (!isSplit(node)) {
    const pane = panes[node.pane];
    if (!pane) return null;
    const focused = tab.focusedPaneId === pane.id;
    // A zoomed tab shows its zoomed pane over the whole tab; the others stay
    // mounted (their state, their editors) but are off screen to their
    // bodies too: no webview, no wall pinned over them.
    const zoomedHere = tab.zoomed === pane.id;
    const hiddenByZoom = !!tab.zoomed && !zoomedHere;
    const shown = active && !hiddenByZoom;
    return (
      <div
        className="rl-wb-pane"
        data-pane-kind={pane.kind}
        data-pane-id={pane.id}
        data-focused={focused ? "" : undefined}
        data-zoomed={zoomedHere ? "" : undefined}
        // Focusable by script only (the stage hands it the caret when its
        // tab is shown), never a Tab stop.
        tabIndex={-1}
        // Focus follows the pointer into a pane (capture, so a click a child
        // swallows still counts); a focused document beside a surface keeps
        // the surface on screen (`view.ts`: the surface never follows focus).
        onPointerDownCapture={focused ? undefined : () => onFocusPane(pane.id)}
      >
        <ErrorBoundary region={pane.kind} fallback={(err, reset) => <PaneFallback region={pane.kind} error={err} reset={reset} />}>
          {renderPane(pane, { visible: visible && !hiddenByZoom, focused, active: shown })}
        </ErrorBoundary>
      </div>
    );
  }
  const children = node.children.map((child, i) => (
    <LayoutView key={i} node={child} path={[...path, i]} tab={tab} panes={panes} active={active} visible={visible} renderPane={renderPane} onFocusPane={onFocusPane} onResize={onResize} onSplitDragging={onSplitDragging} />
  ));
  return (
    <SplitView
      column={node.direction === "column"}
      weights={node.weights}
      onWeightsChange={(weights) => onResize(tab.id, path, weights)}
      onDraggingChange={onSplitDragging}
    >
      {children}
    </SplitView>
  );
}

/** `el` sits under a `display: none` ancestor (or is one): focused, it is
 *  a caret nobody can see. Walked only on a tab's show. */
function undrawn(el: Element): boolean {
  for (let at: Element | null = el; at && at !== document.body; at = at.parentElement) {
    if (getComputedStyle(at).display === "none") return true;
  }
  return false;
}

/** The narrowest share a child of a split keeps while a divider drags
 *  (`MIN_SPLIT_SHARE`, which the reducer keeps too). A weight of 0 is not a
 *  weight, and a pane goes by its own ✕, not by a drag to the edge. */
export const MIN_SHARE = MIN_SPLIT_SHARE;

/** The divider's thickness, in px. */
const DIVIDER = 6;

/** A split of any arity: its children laid out by weight (each child's
 *  `flex-grow`, over a zero basis, so the dividers' own pixels come off the
 *  top), and a divider in every gap. A drag moves the two children either
 *  side of its divider and no other: the pair's total share is fixed, each
 *  keeps `MIN_SHARE` of the whole split. The live shares are written straight
 *  onto the pair's `flex-grow`, so a drag frame costs two style writes plus
 *  layout and re-renders no pane; the split's weights take the result once,
 *  on release. A drag holds a resize session (`lib/resizeSession`), so every
 *  native webview shows its snapshot meanwhile, and `onDraggingChange` tells
 *  App. A double-click evens the pair. */
export function SplitView({ column, weights, onWeightsChange, onDraggingChange, children }: {
  column: boolean;
  weights: readonly number[];
  onWeightsChange: (next: number[]) => void;
  onDraggingChange?: (dragging: boolean) => void;
  children: ReactNode[];
}) {
  const cells = useRef<(HTMLDivElement | null)[]>([]);
  const n = children.length;
  const shares = normalizeWeights(weights, n);
  const startDrag = (gap: number, e: ReactPointerEvent) => {
    e.preventDefault();
    const a = cells.current[gap];
    const b = cells.current[gap + 1];
    if (!a || !b) return;
    // Captured, so a fast drag that leaves the 6px handle keeps tracking.
    const handle = e.currentTarget as HTMLElement;
    const pointerId = e.pointerId;
    handle.setPointerCapture?.(pointerId);
    onDraggingChange?.(true);
    beginResizeSession();
    // Nothing but this drag moves the pair: read it once, not per event.
    const ra = a.getBoundingClientRect();
    const rb = b.getBoundingClientRect();
    const origin = column ? ra.top : ra.left;
    const span = column ? ra.height + rb.height : ra.width + rb.width;
    const total = shares[gap] + shares[gap + 1];
    const lo = Math.min(0.5, MIN_SHARE / total);
    const startShare = total > 0 ? shares[gap] / total : 0.5;
    let pending = startShare;
    const write = (r: number) => {
      a.style.flexGrow = String(r * total);
      b.style.flexGrow = String((1 - r) * total);
    };
    const apply = rafCoalesce(write);
    const move = (ev: PointerEvent) => {
      if (span <= 0) return;
      const pos = (column ? ev.clientY : ev.clientX) - origin - DIVIDER / 2;
      pending = Math.max(lo, Math.min(1 - lo, pos / span));
      apply(pending);
    };
    // Every way a drag ends ends it once: a release commits; a cancel (the
    // OS took the pointer) or a lost capture puts the split back. Either
    // way the resize session closes, or the webview would stay on its
    // snapshot.
    let done = false;
    const finish = (commit: boolean) => {
      if (done) return;
      done = true;
      apply.cancel();
      // The exact rest position lands before the commit: no frame where the
      // DOM and the state disagree.
      write(commit ? pending : startShare);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", escape, true);
      handle.removeEventListener("lostpointercapture", cancel);
      if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture?.(pointerId);
      if (commit) onWeightsChange(pairAt(shares, gap, pending));
      onDraggingChange?.(false);
      endResizeSession();
    };
    const up = () => finish(true);
    const cancel = () => finish(false);
    // Esc mid-drag puts the split back where it was, and is the drag's alone:
    // captured at the window and stopped there, so no door, pane or menu
    // also takes it as its own dismissal (an untouched door closing under
    // the drag left its pane blank).
    const escape = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      ev.stopPropagation();
      finish(false);
    };
    window.addEventListener("keydown", escape, true);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    handle.addEventListener("lostpointercapture", cancel);
  };
  const out: ReactNode[] = [];
  children.forEach((child, i) => {
    if (i > 0) {
      const gap = i - 1;
      out.push(
        <div
          key={`d${gap}`}
          onPointerDown={(e) => startDrag(gap, e)}
          onDoubleClick={() => onWeightsChange(pairAt(shares, gap, 0.5))}
          title="Drag to resize · double-click to even"
          className="rl-split-divider shrink-0"
          role="separator"
          aria-orientation={column ? "horizontal" : "vertical"}
          data-split-gap={gap}
          style={{ flex: `0 0 ${DIVIDER}px`, cursor: column ? "row-resize" : "col-resize", background: "var(--color-rule)", touchAction: "none" }}
        />,
      );
    }
    out.push(
      <div
        key={`c${i}`}
        ref={(el) => {
          cells.current[i] = el;
        }}
        className="rl-wb-split-cell flex flex-col overflow-hidden min-w-0 min-h-0"
        style={{ flexGrow: shares[i], flexShrink: 1, flexBasis: 0 }}
      >
        {child}
      </div>,
    );
  });
  cells.current.length = n;
  return <div className={`rl-wb-split flex-1 min-w-0 min-h-0 flex ${column ? "flex-col" : "flex-row"}`} data-split-arity={n}>{out}</div>;
}

/** `shares` with the pair at `gap`, `gap + 1` re-divided: `r` of their
 *  total to the first. */
function pairAt(shares: readonly number[], gap: number, r: number): number[] {
  const next = shares.slice();
  const total = next[gap] + next[gap + 1];
  next[gap] = r * total;
  next[gap + 1] = (1 - r) * total;
  return next;
}

function PaneFallback({ region, error, reset }: { region: string; error: Error; reset: () => void }) {
  return (
    <div className="rl-wb-pane-fallback" role="alert">
      <p>The {region} pane hit an error: {error.message}</p>
      <button type="button" onClick={reset}>Try again</button>
    </div>
  );
}

// The singleton slots live in `./singleton` (the pane modules read them on
// the boot path); re-exported for the stage's own readers.
export { Singleton, SingletonElsewhere, SingletonSlot } from "./singleton";

/** The focused visible pane of the active tab, for App's door/drafter rules. */
export function focusedPaneOf(set: TabSet | null | undefined): AnyPane | null {
  const tab = set ? activeTabOf(set) : null;
  return tab && set ? (set.panes[tab.focusedPaneId] ?? null) : null;
}
