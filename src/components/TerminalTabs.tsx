// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { TerminalTabBar } from "./TerminalTabBar";
import { TerminalView } from "./TerminalView";

interface Tab {
  id: string;
  /** cwd this tab's shell was spawned in (null = $HOME, resolved backend). */
  cwd: string | null;
}

interface TerminalTabsProps {
  theme: string;
  fullscreen: boolean;
  onFullscreenChange: (v: boolean) => void;
  onTabsChange: (count: number) => void;
  onActivityChange: (hasUnseen: boolean) => void;
  /** Dock is fully collapsed (no active view is really visible). */
  collapsed: boolean;
  /** Notified whenever the active tab changes. The host (App) uses this to
   *  route post-submit PTY injects to whichever terminal the reviewer is
   *  currently watching. Best-effort: a "wrong" tab is still strictly better
   *  than the alternative of no inject at all. */
  onActiveTabChange?: (id: string) => void;
}

/** Imperative handle so the host (App) can drive tab selection — used by the
 *  reverse of linked navigation: clicking a folder tab focuses the terminal
 *  that lives in that folder. */
export interface TerminalTabsHandle {
  selectTab: (id: string) => void;
}

// Owns the set of terminal tabs and their lifecycle. Every tab's
// <TerminalView> stays mounted (shells + scrollback persist); only the active,
// non-collapsed one is `visible`. The dock is never empty: closing the last
// tab spawns a fresh replacement. Labels are positional (`zsh N` = the tab's
// 1-based slot) and recompute on close, like iTerm2 / Terminal.app / VS Code —
// no monotonic ids, no gaps. New tabs open in $HOME by default; the "here"
// action opens in the active terminal's live working directory instead.
export const TerminalTabs = forwardRef<TerminalTabsHandle, TerminalTabsProps>(
  function TerminalTabs(
    {
      theme,
      fullscreen,
      onFullscreenChange,
      onTabsChange,
      onActivityChange,
      collapsed,
      onActiveTabChange,
    }: TerminalTabsProps,
    ref,
  ) {
  const [tabs, setTabs] = useState<Tab[]>(() => [
    { id: crypto.randomUUID(), cwd: null },
  ]);
  const [activeId, setActiveId] = useState<string>(() => tabs[0].id);
  const [unseen, setUnseen] = useState<Set<string>>(() => new Set());

  // cwd null → backend resolves to $HOME ("root").
  const addTab = (cwd: string | null) => {
    const id = crypto.randomUUID();
    setTabs((prev) => [...prev, { id, cwd }]);
    setActiveId(id);
  };

  // Open a new tab in whatever directory the active terminal is currently in
  // (follows the user's `cd`). Falls back to $HOME if it can't be read.
  const addTabHere = () => {
    void (async () => {
      let dir: string | null = null;
      try {
        dir = await invoke<string | null>("pty_cwd", { id: activeId });
      } catch {
        /* fall back to home */
      }
      addTab(dir);
    })();
  };

  const closeTab = (id: string) => {
    void invoke("pty_kill", { id }).catch(() => {});
    setUnseen((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });

    // Side effects (uuid, active selection) live here, not in a setTabs
    // updater — StrictMode double-invokes updaters and would otherwise desync
    // activeId / spawn two replacement ids.
    if (tabs.length === 1 && tabs[0].id === id) {
      // Last tab: never leave the dock empty — spawn a replacement.
      const newId = crypto.randomUUID();
      setTabs([{ id: newId, cwd: null }]);
      setActiveId(newId);
      return;
    }

    const idx = tabs.findIndex((t) => t.id === id);
    const next = tabs.filter((t) => t.id !== id);
    setTabs(next);
    if (id === activeId) {
      // Prefer the left neighbour, else the right.
      const fallback = next[idx - 1] ?? next[idx] ?? next[0];
      if (fallback) setActiveId(fallback.id);
    }
  };

  // Pure array reorder: drop `fromId` into `toId`'s slot. No side effects, so
  // a setTabs updater is StrictMode-safe. TerminalViews are keyed by id and
  // absolutely stacked, so reordering relabels slots without touching shells.
  const reorderTabs = (from: number, to: number) => {
    setTabs((prev) => {
      if (
        from === to ||
        from < 0 ||
        to < 0 ||
        from >= prev.length ||
        to >= prev.length
      )
        return prev;
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  };

  const selectTab = (id: string) => {
    setActiveId(id);
    setUnseen((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  // Expose tab selection to the host. selectTab/tabs are recreated each render,
  // so the handle reads them through refs and guards against a stale id (a
  // terminal closed since the folder→terminal mapping was recorded).
  const selectTabRef = useRef(selectTab);
  selectTabRef.current = selectTab;
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  useImperativeHandle(
    ref,
    () => ({
      selectTab: (id: string) => {
        if (tabsRef.current.some((t) => t.id === id)) selectTabRef.current(id);
      },
    }),
    [],
  );

  const handleActivity = (id: string) => {
    if (id !== activeId || collapsed) {
      setUnseen((prev) => {
        if (prev.has(id)) return prev;
        const next = new Set(prev);
        next.add(id);
        return next;
      });
    }
  };

  const handleExit = (_id: string) => {
    // Keep the tab around so the user sees "[process exited]"; they close it.
  };

  useEffect(() => {
    onTabsChange(tabs.length);
  }, [tabs.length, onTabsChange]);

  useEffect(() => {
    onActivityChange(unseen.size > 0);
  }, [unseen, onActivityChange]);

  // The active view is genuinely seen once it's active and the dock is open.
  useEffect(() => {
    if (collapsed) return;
    setUnseen((prev) => {
      if (!prev.has(activeId)) return prev;
      const next = new Set(prev);
      next.delete(activeId);
      return next;
    });
  }, [activeId, collapsed]);

  // Notify the host whenever the active tab changes so post-submit PTY
  // injects can target the terminal the reviewer is currently watching.
  useEffect(() => {
    onActiveTabChange?.(activeId);
  }, [activeId, onActiveTabChange]);

  // Positional labels: a tab's number is its 1-based slot, so closing one
  // renumbers the rest with no gaps.
  const barTabs = tabs.map((t, i) => ({ id: t.id, title: `zsh ${i + 1}` }));

  return (
    <div className="flex flex-col h-full">
      <TerminalTabBar
        tabs={barTabs}
        activeId={activeId}
        fullscreen={fullscreen}
        onSelect={selectTab}
        onNew={() => addTab(null)}
        onNewHere={addTabHere}
        onClose={closeTab}
        onToggleFullscreen={() => onFullscreenChange(!fullscreen)}
        onReorder={reorderTabs}
      />
      <div className="flex-1 relative">
        {tabs.map((t) => (
          <div key={t.id} className="absolute inset-0">
            <TerminalView
              id={t.id}
              cwd={t.cwd}
              theme={theme}
              visible={t.id === activeId && !collapsed}
              onActivity={handleActivity}
              onExit={handleExit}
            />
          </div>
        ))}
      </div>
    </div>
  );
  },
);
