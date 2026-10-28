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

import { lazy, memo, Suspense, useCallback, useDeferredValue, useLayoutEffect, useMemo, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

import { ErrorBoundary } from "../components/ErrorBoundary";
import { rafCoalesce } from "../lib/raf";
import { beginResizeSession, endResizeSession } from "../lib/resizeSession";
import { activeTabOf, isSplit, paneIdsOf, paneTitle, type AnyPane, type LayoutNode, type Tab, type TabSet } from "./model";
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
}

const selectSet = (s: ReturnType<WorkbenchStore["getState"]>): TabSet | null => s.sets[s.activeKey] ?? null;
const selectKey = (s: ReturnType<WorkbenchStore["getState"]>) => s.activeKey;

export function WorkbenchStage({ store, renderPane, describePane, onSplitDragging, right, onNewTab, onCloseTab }: WorkbenchStageProps) {
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
      const item: TabStripItem = { id, kind: lead.kind, title: described[leadIndex]?.title ?? paneTitle(lead), status, preview: lead.preview, count: described[leadIndex]?.count, tour: tourOf(lead) };
      return [item];
    });
  }, [set, describePane]);

  if (!set) return <div className="rl-wb-stage" />;
  return (
    <div className="rl-wb-stage" data-wb-key={activeKey}>
      <Suspense fallback={<div className="rl-wb-strip" aria-hidden />}>
        <TabStrip tabs={tabs} activeTabId={activeTabId} onSelect={onSelect} onClose={onClose} onReorder={onReorder} onRename={onRename} onNew={onNewTab} onReopen={onReopen} canReopen={set.closed.length > 0} right={right} />
      </Suspense>
      <div className="rl-wb-tabs">
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
      </div>
    </div>
  );
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
    return (
      <div
        className="rl-wb-pane"
        data-pane-kind={pane.kind}
        data-focused={focused ? "" : undefined}
        // Focusable by script only (the stage hands it the caret when its
        // tab is shown), never a Tab stop.
        tabIndex={-1}
        // Focus follows the pointer into a pane (capture, so a click a child
        // swallows still counts); a focused document beside a surface keeps
        // the surface on screen (`view.ts`: the surface never follows focus).
        onPointerDownCapture={focused ? undefined : () => onFocusPane(pane.id)}
      >
        <ErrorBoundary region={pane.kind} fallback={(err, reset) => <PaneFallback region={pane.kind} error={err} reset={reset} />}>
          {renderPane(pane, { visible, focused, active })}
        </ErrorBoundary>
      </div>
    );
  }
  const children = node.children.map((child, i) => (
    <LayoutView key={i} node={child} path={[...path, i]} tab={tab} panes={panes} active={active} visible={visible} renderPane={renderPane} onFocusPane={onFocusPane} onResize={onResize} onSplitDragging={onSplitDragging} />
  ));
  if (children.length === 2) {
    return (
      <TwoUp
        column={node.direction === "column"}
        ratio={node.weights[0] ?? 0.5}
        onRatioChange={(r) => onResize(tab.id, path, [r, 1 - r])}
        onDraggingChange={onSplitDragging}
        first={children[0]}
        second={children[1]}
      />
    );
  }
  // Wider splits are W5's (the n-ary divider); until then they lay out by
  // weight with no divider.
  return (
    <div className="rl-wb-split" style={{ display: "flex", flexDirection: node.direction === "column" ? "column" : "row", flex: 1, minHeight: 0, minWidth: 0 }}>
      {children.map((child, i) => (
        <div key={i} style={{ flex: `${node.weights[i] ?? 1} 1 0`, minHeight: 0, minWidth: 0, display: "flex", flexDirection: "column" }}>
          {child}
        </div>
      ))}
    </div>
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

/** The narrowest share a pane of the tile keeps while its divider drags. A
 *  weight of 0 is not a weight (`normalizeWeights` would even the split), and
 *  a pane goes by its own ✕, not by a drag to the edge. */
export const MIN_SHARE = 0.1;

const clampShare = (r: number) => Math.max(MIN_SHARE, Math.min(1 - MIN_SHARE, r));

/** Two children of a split and the divider between them. The live share is
 *  written straight onto the first child's flex-basis, so a drag frame costs
 *  one style write plus layout and re-renders neither pane (a custom property
 *  on the container would invalidate style for both whole subtrees); the
 *  tab's weights take the result once, on release. A drag holds a resize
 *  session (`lib/resizeSession`), so the native webview shows its snapshot
 *  meanwhile, and `onDraggingChange` tells App. */
function TwoUp({ column, ratio, onRatioChange, onDraggingChange, first, second }: {
  column: boolean;
  ratio: number;
  onRatioChange: (next: number) => void;
  onDraggingChange?: (dragging: boolean) => void;
  first: ReactNode;
  second: ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const firstRef = useRef<HTMLDivElement | null>(null);
  const startDrag = (e: ReactPointerEvent) => {
    e.preventDefault();
    const el = containerRef.current;
    if (!el) return;
    // Captured, so a fast drag that leaves the 6px handle keeps tracking.
    const handle = e.currentTarget as HTMLElement;
    const pointerId = e.pointerId;
    handle.setPointerCapture?.(pointerId);
    onDraggingChange?.(true);
    beginResizeSession();
    // The container cannot move during the drag: read it once, not per event.
    const rect = el.getBoundingClientRect();
    const size = column ? rect.height : rect.width;
    const origin = column ? rect.top : rect.left;
    const start = clampShare(ratio);
    let pending = start;
    const apply = rafCoalesce((r: number) => {
      if (firstRef.current) firstRef.current.style.flexBasis = `${r * 100}%`;
    });
    const move = (ev: PointerEvent) => {
      const pos = column ? ev.clientY : ev.clientX;
      pending = clampShare(size > 0 ? (pos - origin) / size : 0.5);
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
      const rest = commit ? pending : start;
      // The exact rest position lands before the commit: no frame where the
      // DOM and the state disagree.
      if (firstRef.current) firstRef.current.style.flexBasis = `${rest * 100}%`;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", escape, true);
      handle.removeEventListener("lostpointercapture", cancel);
      if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture?.(pointerId);
      if (commit) onRatioChange(pending);
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
  return (
    <div ref={containerRef} className={`rl-wb-split flex-1 min-w-0 min-h-0 flex ${column ? "flex-col" : "flex-row"}`}>
      <div ref={firstRef} className="flex flex-col overflow-hidden min-w-0 min-h-0" style={{ flexGrow: 0, flexShrink: 0, flexBasis: `${clampShare(ratio) * 100}%` }}>
        {first}
      </div>
      <div
        onPointerDown={startDrag}
        onDoubleClick={() => onRatioChange(0.5)}
        title="Drag to resize · double-click to even"
        className="rl-split-divider shrink-0"
        role="separator"
        aria-orientation={column ? "horizontal" : "vertical"}
        style={{ flex: "0 0 6px", cursor: column ? "row-resize" : "col-resize", background: "var(--color-rule)", touchAction: "none" }}
      />
      <div className="flex flex-col overflow-hidden min-w-0 min-h-0 flex-1">{second}</div>
    </div>
  );
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
