// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// The centre of the window under the workbench: the active set's tab strip
// and, below it, the active tab's panes — a pane, or the one split W1 allows
// (a document-family pane beside a surface, the SplitPane the doc pin used).
// App hands in `renderPane`, which maps a pane to the body it already builds
// (the plan article, the browser's slot, the drafter…), so this file knows
// kinds and layout and nothing about what a plan is.
//
// Kept tabs: the active tab and the three most recently shown stay mounted.
// A hidden kept tab is `inert` and skips layout and paint (styles.css), so its
// webviews, editors and terminals keep their state without laying out or
// painting, and switching back mounts nothing. Visibility reaches panes
// through `useDeferredValue`, so the strip and the tab paint before any
// pane reacts to being shown (a native webview coming forward, a review
// poll resuming). Singleton bodies never mount inside a tab — only their
// slots do (`SingletonSlot`).

import { lazy, memo, Suspense, useCallback, useDeferredValue, useEffect, useMemo, useRef, type ReactNode } from "react";

import { ErrorBoundary } from "../components/ErrorBoundary";
import { PersistentPortalSlot } from "../components/PersistentPortalSlot";
import { SplitPane } from "../components/SplitPane";
import { activeTabOf, isSplit, paneIdsOf, paneTitle, type AnyPane, type LayoutNode, type Tab, type TabSet } from "./model";
import { endMeasure } from "./perf";
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
}

const selectSet = (s: ReturnType<WorkbenchStore["getState"]>): TabSet | null => s.sets[s.activeKey] ?? null;
const selectKey = (s: ReturnType<WorkbenchStore["getState"]>) => s.activeKey;

export function WorkbenchStage({ store, renderPane, describePane, onSplitDragging, right, onNewTab }: WorkbenchStageProps) {
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

  // `wb:tab-switch` ends once the new active tab has painted.
  useEffect(() => {
    if (!activeTabId) return;
    const frame = requestAnimationFrame(() => endMeasure("wb:tab-switch"));
    return () => cancelAnimationFrame(frame);
  }, [activeTabId]);

  const dispatch = store.dispatch;
  const onSelect = useCallback((tabId: string) => dispatch({ type: "selectTab", tabId }), [dispatch]);
  const onClose = useCallback((tabId: string) => dispatch({ type: "closeTab", tabId }), [dispatch]);
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
      const item: TabStripItem = { id, kind: lead.kind, title: described[leadIndex]?.title ?? paneTitle(lead), status, preview: lead.preview, count: described[leadIndex]?.count };
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
  return (
    <div
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
        // Focus follows the pointer into a pane (capture, so a click a child
        // swallows still counts); a focused document beside a surface keeps
        // the surface on screen (`legacyView`: the surface never follows
        // focus).
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
      <SplitPane
        vertical={node.direction === "column"}
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

function PaneFallback({ region, error, reset }: { region: string; error: Error; reset: () => void }) {
  return (
    <div className="rl-wb-pane-fallback" role="alert">
      <p>The {region} pane hit an error: {error.message}</p>
      <button type="button" onClick={reset}>Try again</button>
    </div>
  );
}

/** A singleton's slot: `PersistentPortalSlot`, taking the host only while
 *  the pane is visible, so a slot in a hidden kept tab cannot steal it. The
 *  second visible slot (W5's splits) shows where the body went. */
export function SingletonSlot({ host, name, active }: { host: HTMLElement; name: string; active: boolean }) {
  return <PersistentPortalSlot host={host} name={name} active={active} />;
}

/** The focused visible pane of the active tab, for App's door/drafter rules. */
export function focusedPaneOf(set: TabSet | null | undefined): AnyPane | null {
  const tab = set ? activeTabOf(set) : null;
  return tab && set ? (set.panes[tab.focusedPaneId] ?? null) : null;
}
