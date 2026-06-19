// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { homeDir } from "@tauri-apps/api/path";
import { usePersistedState } from "../theme/usePersistedState";
import { TerminalTabBar } from "./TerminalTabBar";
import { TerminalView, enqueuePtyOp } from "./TerminalView";
import { TerminalSplitDivider } from "./TerminalSplitDivider";
import { CloseConfirmModal } from "./CloseConfirmModal";

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
  /** Notified whenever the focused tab changes. The host (App) uses this to
   *  route post-submit PTY injects and cwd-follow polling to whichever terminal
   *  the reviewer is currently watching. Best-effort: a "wrong" tab is still
   *  strictly better than the alternative of no inject at all. */
  onActiveTabChange?: (id: string) => void;
}

/** Imperative handle so the host (App) can drive tab selection — used by the
 *  reverse of linked navigation: clicking a folder tab focuses the terminal
 *  that lives in that folder. */
export interface TerminalTabsHandle {
  selectTab: (id: string) => void;
  /** Open a fresh terminal tab in `cwd`, focus it, and return its id so the
   *  host can drive it (e.g. "Restore plan session" writes `claude --resume …`
   *  into it). cwd null → backend resolves to $HOME. */
  openSessionTerminal: (cwd: string | null) => string;
}

/** Trailing-slash-insensitive path compare key. */
function normPath(p: string): string {
  return p.replace(/\/+$/, "") || "/";
}

// Owns the set of terminal tabs and their lifecycle. Every tab's
// <TerminalView> stays mounted (shells + scrollback persist); only the tabs
// shown in a pane are `visible`. The dock can show one pane or be split into
// two side-by-side panes (`paneA` left, `paneB` right) — splitting is purely a
// view change: toggling it on/off never spawns-and-kills the underlying shells,
// so sessions and scrollback survive. The dock is never empty: closing the last
// tab spawns a fresh replacement. Labels are project-aware: each tab is named
// after its live cwd's basename, numbered per project in tab order ("redline 1,
// redline 2, zsh 1") — $HOME and / fall back to "zsh". Numbering recomputes on
// close/reorder/cd, like iTerm2 / Terminal.app / VS Code.
// New tabs open in $HOME by default; the "here" action opens in the focused
// terminal's live working directory instead.
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
  // The two pane slots. `paneA` is always set (the left/primary pane); `paneB`
  // is null unless split. `focusedPane` is the one driving the bar highlight,
  // cwd-follow polling and PTY injection.
  const [paneA, setPaneA] = useState<string>(() => tabs[0].id);
  const [paneB, setPaneB] = useState<string | null>(null);
  const [focusedPane, setFocusedPane] = useState<"A" | "B">("A");
  const [splitRatio, setSplitRatio] = usePersistedState(
    "redline.terminalPane.splitRatio",
    0.5,
  );
  const [unseen, setUnseen] = useState<Set<string>>(() => new Set());
  // Set when a window-close is intercepted because a terminal has moved off its
  // start dir; drives the Redline-styled confirmation modal.
  const [showCloseConfirm, setShowCloseConfirm] = useState(false);

  const split = paneB !== null;
  const focusedId = focusedPane === "B" && paneB ? paneB : paneA;
  const paneContainerRef = useRef<HTMLDivElement | null>(null);

  // Drop `id` from the unseen set (it's now on screen / chosen).
  const clearUnseen = (id: string) =>
    setUnseen((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });

  // Load a tab into whichever pane currently has focus.
  const showInFocusedPane = (id: string) => {
    if (split && focusedPane === "B") setPaneB(id);
    else setPaneA(id);
  };

  // cwd null → backend resolves to $HOME ("root"). New tab opens in the focused
  // pane (preserves the "the tab I just made is the one I'm looking at" feel).
  const addTab = (cwd: string | null) => {
    const id = crypto.randomUUID();
    setTabs((prev) => [...prev, { id, cwd }]);
    showInFocusedPane(id);
    return id;
  };

  // Open a new tab in whatever directory the focused terminal is currently in
  // (follows the user's `cd`). Falls back to $HOME if it can't be read.
  const addTabHere = () => {
    void (async () => {
      let dir: string | null = null;
      try {
        dir = await invoke<string | null>("pty_cwd", { id: focusedId });
      } catch {
        /* fall back to home */
      }
      addTab(dir);
    })();
  };

  // Like addTabHere, but auto-launches Claude in plan mode in the new shell —
  // same PTY-injection pattern as restorePlanSession (wait for the shell's rc
  // files, then write the command with a trailing \r so it runs).
  const addTabHereClaude = () => {
    void (async () => {
      let dir: string | null = null;
      try {
        dir = await invoke<string | null>("pty_cwd", { id: focusedId });
      } catch {
        /* fall back to home */
      }
      const id = addTab(dir);
      window.setTimeout(() => {
        void invoke("pty_write", { id, data: "claude --permission-mode plan\r" });
      }, 900);
    })();
  };

  // Toggle the side-by-side split. Turning it on fills pane B with another open
  // tab, spawning a fresh shell if this is the only tab. Turning it off just
  // drops pane B from view — the shell keeps running, untouched.
  const toggleSplit = () => {
    if (paneB !== null) {
      setPaneB(null);
      setFocusedPane("A");
      return;
    }
    const other = tabs.find((t) => t.id !== paneA);
    if (other) {
      setPaneB(other.id);
    } else {
      // Only one tab exists: give pane B a fresh shell so the split is usable.
      const newId = crypto.randomUUID();
      setTabs((prev) => [...prev, { id: newId, cwd: null }]);
      setPaneB(newId);
    }
    setFocusedPane("B");
  };

  // Prefer the left neighbour of the closed slot, then the right, then any
  // surviving tab — skipping ids already shown in the other pane so the two
  // panes never display the same session.
  const pickFallback = (
    next: Tab[],
    idx: number,
    avoid: (string | null)[],
  ): string | null => {
    const blocked = new Set(avoid.filter((x): x is string => x !== null));
    const ordered = [next[idx - 1], next[idx], ...next].filter(
      (t): t is Tab => t != null,
    );
    for (const t of ordered) if (!blocked.has(t.id)) return t.id;
    return null;
  };

  const closeTab = (id: string) => {
    // Through the lifecycle fence: closing a tab the instant it opened must
    // not let the kill overtake the still-queued spawn (orphan shell).
    void enqueuePtyOp(id, () => invoke("pty_kill", { id }));
    clearUnseen(id);

    // Side effects (uuid, pane selection) live here, not in a setTabs updater —
    // StrictMode double-invokes updaters and would otherwise desync the panes /
    // spawn two replacement ids.
    if (tabs.length === 1 && tabs[0].id === id) {
      // Last tab: never leave the dock empty — spawn a replacement.
      const newId = crypto.randomUUID();
      setTabs([{ id: newId, cwd: null }]);
      setPaneA(newId);
      setPaneB(null);
      setFocusedPane("A");
      return;
    }

    const idx = tabs.findIndex((t) => t.id === id);
    const next = tabs.filter((t) => t.id !== id);
    setTabs(next);

    // Reassign any pane that was showing the closed tab.
    if (id === paneA) {
      const fb = pickFallback(next, idx, [paneB]);
      if (fb) {
        setPaneA(fb);
      } else if (paneB) {
        // Only pane B's tab remains — collapse the split into it.
        setPaneA(paneB);
        setPaneB(null);
        setFocusedPane("A");
      }
    } else if (id === paneB) {
      const fb = pickFallback(next, idx, [paneA]);
      if (fb) setPaneB(fb);
      else {
        setPaneB(null);
        setFocusedPane("A");
      }
    }
  };

  // Pure array reorder: drop `fromId` into `toId`'s slot. No side effects, so
  // a setTabs updater is StrictMode-safe. TerminalViews are keyed by id and
  // positioned by pane role, so reordering relabels slots without touching
  // shells.
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

  // Pick a tab into a *specific* pane (used by each pane's own tab strip while
  // split). Clicking the tab that already lives in the other pane swaps the two
  // panes' contents — so you can flip which side a session is on, or change
  // which session the split pane shows, without ever duplicating one.
  const selectInto = (pane: "A" | "B", id: string) => {
    setFocusedPane(pane);
    if (pane === "A") {
      // Clicking pane B's tab in pane A's strip swaps the two panes.
      if (id === paneB) setPaneB(paneA);
      setPaneA(id);
    } else {
      // Mirror: clicking pane A's tab in pane B's strip swaps them. paneB is
      // non-null here (we're split), so it's a safe source for pane A.
      if (id === paneA && paneB !== null) setPaneA(paneB);
      setPaneB(id);
    }
    clearUnseen(id);
  };

  const selectTab = (id: string) => {
    // Already on screen in the other pane → just move focus there (never show
    // the same session in both panes).
    if (split) {
      if (focusedPane === "A" && id === paneB) {
        setFocusedPane("B");
        clearUnseen(id);
        return;
      }
      if (focusedPane === "B" && id === paneA) {
        setFocusedPane("A");
        clearUnseen(id);
        return;
      }
    }
    showInFocusedPane(id);
    clearUnseen(id);
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
      openSessionTerminal: (cwd: string | null) => {
        const id = crypto.randomUUID();
        setTabs((prev) => [...prev, { id, cwd }]);
        // selectTabRef is reassigned every render, so it sees the live pane
        // state and shows the new tab in the focused pane.
        selectTabRef.current(id);
        return id;
      },
    }),
    [],
  );

  // Guard the window close: like a real terminal app, confirm before tearing
  // down a session that has work in flight. We treat "moved off the directory it
  // opened in" as the signal — a terminal still sitting at its start dir ($HOME,
  // or its "open here" dir) is disposable and closes without a prompt.
  useEffect(() => {
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    let disposed = false;

    const norm = (p: string) => p.replace(/\/+$/, "") || "/";
    const anyTerminalMoved = async (): Promise<boolean> => {
      let home = "";
      try {
        home = await homeDir();
      } catch {
        /* compare against explicit cwds only if HOME is unreadable */
      }
      for (const t of tabsRef.current) {
        const initial = t.cwd ?? home;
        if (!initial) continue;
        let live: string | null = null;
        try {
          live = await invoke<string | null>("pty_cwd", { id: t.id });
        } catch {
          /* shell gone / unreadable → treat as not moved */
        }
        if (live && norm(live) !== norm(initial)) return true;
      }
      return false;
    };

    void win
      .onCloseRequested(async (event) => {
        let moved = false;
        try {
          moved = await anyTerminalMoved();
        } catch {
          /* on any failure, don't block the close */
        }
        if (!moved) return;
        event.preventDefault();
        setShowCloseConfirm(true);
      })
      .then((u) => {
        if (disposed) u();
        else unlisten = u;
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const handleActivity = (id: string) => {
    const visibleNow = id === paneA || id === paneB;
    if (!visibleNow || collapsed) {
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

  // A pane's view is genuinely seen once it's shown and the dock is open. Clear
  // the unseen badge for every currently-visible pane.
  useEffect(() => {
    if (collapsed) return;
    setUnseen((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const vid of [paneA, paneB]) {
        if (vid && next.delete(vid)) changed = true;
      }
      return changed ? next : prev;
    });
  }, [paneA, paneB, collapsed]);

  // Notify the host whenever the focused tab changes so post-submit PTY injects
  // and cwd-follow polling target the terminal the reviewer is watching.
  useEffect(() => {
    onActiveTabChange?.(focusedId);
  }, [focusedId, onActiveTabChange]);

  // Live cwd per tab, polled so labels follow the shell's `cd`. Spawn cwd
  // covers the gap until the first poll lands.
  const [liveCwds, setLiveCwds] = useState<Map<string, string>>(
    () => new Map(),
  );
  const [homePath, setHomePath] = useState<string | null>(null);
  useEffect(() => {
    void homeDir()
      .then((h) => setHomePath(normPath(h)))
      .catch(() => {});
  }, []);
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      const entries = await Promise.all(
        tabs.map(async (t) => {
          try {
            const dir = await invoke<string | null>("pty_cwd", { id: t.id });
            return [t.id, dir] as const;
          } catch {
            return [t.id, null] as const;
          }
        }),
      );
      if (cancelled) return;
      setLiveCwds((prev) => {
        const next = new Map<string, string>();
        let changed = false;
        for (const [id, dir] of entries) {
          const val = dir ?? prev.get(id);
          if (val) next.set(id, val);
          if (prev.get(id) !== next.get(id)) changed = true;
        }
        if (prev.size !== next.size) changed = true;
        return changed ? next : prev;
      });
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 2500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [tabs]);

  // Project-aware labels: basename of the tab's live cwd ($HOME / root →
  // "zsh"), numbered per project in tab order — "redline 1, redline 2, zsh 1".
  // Derived at render, so close/reorder/cd all renumber automatically.
  const tabBaseLabel = (t: Tab): string => {
    const dir = liveCwds.get(t.id) ?? t.cwd;
    if (!dir) return "zsh";
    const n = normPath(dir);
    if (n === "/" || (homePath !== null && n === homePath)) return "zsh";
    return n.slice(n.lastIndexOf("/") + 1) || "zsh";
  };
  const labelCounts = new Map<string, number>();
  const barTabs = tabs.map((t) => {
    const label = tabBaseLabel(t);
    const n = (labelCounts.get(label) ?? 0) + 1;
    labelCounts.set(label, n);
    return { id: t.id, title: `${label} ${n}` };
  });

  // Position each tab's wrapper by its pane role using CSS only — never by
  // moving it to a different JSX parent, which would unmount/remount the
  // TerminalView and kill its PTY. Hidden tabs stack full-bleed (their own
  // display:none keeps them off screen).
  const wrapperStyle = (role: "A" | "B" | null): CSSProperties => {
    const base: CSSProperties = { position: "absolute", top: 0, bottom: 0 };
    if (!split || role === null) return { ...base, left: 0, right: 0 };
    if (role === "A") return { ...base, left: 0, width: `${splitRatio * 100}%` };
    return { ...base, left: `${splitRatio * 100}%`, right: 0 };
  };

  // Shared action-button wiring, reused by whichever strip carries the actions.
  const barActions = {
    fullscreen,
    split,
    onNew: () => addTab(null),
    onNewHere: addTabHere,
    onNewHereClaude: addTabHereClaude,
    onToggleSplit: toggleSplit,
    onToggleFullscreen: () => onFullscreenChange(!fullscreen),
    onClose: closeTab,
    onReorder: reorderTabs,
  };

  return (
    <div data-tour="terminal" className="flex flex-col h-full">
      {split && paneB ? (
        // One tab strip per pane, aligned over its pane so a split session's
        // tab indicator sits above the pane it's actually running in.
        <div className="flex items-stretch shrink-0">
          <div
            style={{
              width: `${splitRatio * 100}%`,
              borderRight: "1px solid var(--color-rule)",
            }}
          >
            <TerminalTabBar
              {...barActions}
              tabs={barTabs}
              activeId={paneA}
              focused={focusedPane === "A"}
              showActions={false}
              onSelect={(id) => selectInto("A", id)}
            />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <TerminalTabBar
              {...barActions}
              tabs={barTabs}
              activeId={paneB}
              focused={focusedPane === "B"}
              showActions
              onSelect={(id) => selectInto("B", id)}
            />
          </div>
        </div>
      ) : (
        <TerminalTabBar
          {...barActions}
          tabs={barTabs}
          activeId={focusedId}
          showActions
          onSelect={selectTab}
        />
      )}
      <div ref={paneContainerRef} className="flex-1 relative">
        {tabs.map((t) => {
          const role: "A" | "B" | null =
            t.id === paneA ? "A" : t.id === paneB ? "B" : null;
          return (
            <div key={t.id} style={wrapperStyle(role)}>
              <TerminalView
                id={t.id}
                cwd={t.cwd}
                theme={theme}
                visible={role !== null && !collapsed}
                onActivity={handleActivity}
                onExit={handleExit}
                onPaneFocus={role ? () => setFocusedPane(role) : undefined}
              />
            </div>
          );
        })}
        {split && (
          <TerminalSplitDivider
            ratio={splitRatio}
            onRatioChange={setSplitRatio}
            containerRef={paneContainerRef}
          />
        )}
      </div>
      {showCloseConfirm && (
        <CloseConfirmModal
          onConfirm={() => {
            // destroy() bypasses the onCloseRequested guard we set above.
            void getCurrentWindow().destroy();
          }}
          onCancel={() => setShowCloseConfirm(false)}
        />
      )}
    </div>
  );
  },
);
