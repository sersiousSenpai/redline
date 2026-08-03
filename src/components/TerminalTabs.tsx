// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { homeDir } from "@tauri-apps/api/path";
import { usePersistedState } from "../theme/usePersistedState";
import {
  bumpMru,
  groupTerminals,
  orderRepos,
  type TerminalRef,
} from "../lib/repoBubbles";
import { workSignal } from "../lib/termTitle";
import { iconFor } from "../lib/repoIcon";
import { useRepoIcons } from "../hooks/useRepoIcons";
import type { ProjectOption } from "./ProjectPicker";
import { ErrorBoundary } from "./ErrorBoundary";
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
  /** Dock terminals whose `claude` is currently held awaiting review. Each such
   *  tab gets its own "plan intercepted by redline" strip inside its pane, so a
   *  split dock shows the truth per pane rather than one dock-wide band. */
  heldTerminalIds?: ReadonlySet<string>;
  /** What each held terminal is stopped on, by tab id — the plan's title. The
   *  repo popover names it, so a row says which piece of work that terminal is,
   *  not just where it is. */
  heldPlanTitles?: ReadonlyMap<string, string>;
  /** Recent repo directories for the tab bar's quick-open bubbles. The same
   *  list the drafter's launch picker uses — review sessions by recency, then
   *  open folder workspaces. */
  projectOptions?: readonly ProjectOption[];
}

/** How many repos the bubble strip will consider (what actually renders is
 *  whatever fits) and how deep the click-order memory runs. */
const MAX_BUBBLES = 12;

/** The intercept strip. Text can't be injected into the held PTY, so this fakes
 *  one line of terminal output: terminal bg + mono font + matching padding so
 *  it sits on the glyph grid and reads as native output. Click-through, so the
 *  shell underneath stays usable. Pinned to the bottom of whichever pane hosts
 *  the held terminal — the tab wrapper is `position: absolute`, so it is the
 *  containing block. */
function InterceptStrip() {
  return (
    <div
      aria-hidden
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 20,
        pointerEvents: "none",
        background: "var(--color-paper)",
        fontFamily: "var(--font-mono)",
        fontSize: 13,
        lineHeight: "18px",
        padding: "2px 8px",
        color: "#e8553d",
        whiteSpace: "pre",
        overflow: "hidden",
      }}
    >
      {"── plan intercepted by redline ──"}
    </div>
  );
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

/** The directory a tab's label and repo mark describe — its live cwd,
 *  normalized — or null when that's `$HOME` or `/`.
 *
 *  A bare shell in either isn't in a project, so it gets the "zsh" label and no
 *  repo lookup at all: `$HOME` has no `.git`, so resolving it would hand the tab
 *  a monogram for the user's own account name. */
function tabProjectDir(
  dir: string | null | undefined,
  homePath: string | null,
): string | null {
  if (!dir) return null;
  const n = normPath(dir);
  if (n === "/" || (homePath !== null && n === homePath)) return null;
  return n;
}

/** A tab's label: the basename of its project directory, or "zsh". */
function tabBaseLabel(dir: string | null): string {
  return dir === null ? "zsh" : dir.slice(dir.lastIndexOf("/") + 1) || "zsh";
}

/** `/Users/me/redline` → `~/redline`, so a tooltip stays readable. */
function tildeify(path: string, homePath: string | null): string {
  if (homePath && (path === homePath || path.startsWith(`${homePath}/`))) {
    return `~${path.slice(homePath.length)}`;
  }
  return path;
}

/** Elements positioned by the inner split's ratio, tagged so the divider's
 *  live path can find and move them directly (see `applySplitRatio`). */
const SPLIT_A = "data-rl-split-a";
const SPLIT_B = "data-rl-split-b";

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
// Memoized: a dock drag's one release commit (and any unrelated App state
// change) must not walk the whole terminal fleet's tree.
export const TerminalTabs = memo(
  forwardRef<TerminalTabsHandle, TerminalTabsProps>(
  function TerminalTabs(
    {
      theme,
      fullscreen,
      onFullscreenChange,
      onTabsChange,
      onActivityChange,
      collapsed,
      onActiveTabChange,
      heldTerminalIds,
      heldPlanTitles,
      projectOptions,
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
    // The divider commits a ratio per frame during a drag; batch the
    // localStorage writes so the drag stays main-thread-cheap.
    { debounceMs: 250 },
  );
  // Click order for the repo bubbles: the repo you opened a terminal in last
  // leads the strip, ahead of the host's own recency order.
  const [recentDirs, setRecentDirs] = usePersistedState<string[]>(
    "redline.terminalPane.recentDirs",
    [],
  );
  const [unseen, setUnseen] = useState<Set<string>>(() => new Set());
  // Set when a window-close is intercepted because a terminal has moved off its
  // start dir; drives the Redline-styled confirmation modal.
  const [showCloseConfirm, setShowCloseConfirm] = useState(false);

  const split = paneB !== null;
  const focusedId = focusedPane === "B" && paneB ? paneB : paneA;
  const paneContainerRef = useRef<HTMLDivElement | null>(null);
  // The dock root. The inner divider's live path reaches the elements it
  // positions through here.
  const rootRef = useRef<HTMLDivElement | null>(null);
  // Move everything the split ratio positions, without a render. Called once
  // per frame by TerminalSplitDivider, and once more at rest.
  const applySplitRatio = useCallback((r: number) => {
    const root = rootRef.current;
    if (!root) return;
    const pct = `${r * 100}%`;
    root
      .querySelectorAll<HTMLElement>(`[${SPLIT_A}]`)
      .forEach((el) => (el.style.width = pct));
    root
      .querySelectorAll<HTMLElement>(`[${SPLIT_B}]`)
      .forEach((el) => (el.style.left = pct));
  }, []);

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

  // Stable handlers so the memoized TerminalView fleet doesn't re-render on
  // every TerminalTabs render. handleActivity only re-identities when the
  // visible panes / collapse change (a tab switch), which is exactly when its
  // visibility test should be re-evaluated.
  const handleActivity = useCallback(
    (id: string) => {
      const visibleNow = id === paneA || id === paneB;
      if (!visibleNow || collapsed) {
        setUnseen((prev) => {
          if (prev.has(id)) return prev;
          const next = new Set(prev);
          next.add(id);
          return next;
        });
      }
    },
    [paneA, paneB, collapsed],
  );

  const handleExit = useCallback((_id: string) => {
    // Keep the tab around so the user sees "[process exited]"; they close it.
  }, []);

  // Last window title each terminal announced (OSC 0/2) — "what is running in
  // here", for the repo popover. Stable identity, and it bails when the title
  // is unchanged, so a shell that rewrites the same title on every prompt costs
  // no render. Titles only arrive for tabs xterm has actually parsed: a hidden
  // tab's bytes are stashed unparsed, so its title lands when it's next shown.
  const [termTitles, setTermTitles] = useState<Map<string, string>>(
    () => new Map(),
  );
  const handleTitle = useCallback((id: string, title: string) => {
    setTermTitles((prev) => {
      if (prev.get(id) === title) return prev;
      const next = new Map(prev);
      next.set(id, title);
      return next;
    });
  }, []);

  // One stable callback per split role — avoids minting a fresh onPaneFocus for
  // every tab on each render.
  const focusPaneA = useCallback(() => setFocusedPane("A"), []);
  const focusPaneB = useCallback(() => setFocusedPane("B"), []);

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
  // Live-cwd polling, scoped to the *visible* panes. Each `pty_cwd` spawns an
  // `lsof` subprocess, so polling all N tabs every 2.5s was N subprocesses a
  // tick for labels the user mostly can't see. Hidden tabs keep their
  // last-known label and refresh the instant they're shown again (paneA/paneB
  // change re-runs this effect). Drops the steady-state spawn rate from one per
  // tab to at most two.
  useEffect(() => {
    let cancelled = false;
    const visibleIds = Array.from(
      new Set([paneA, paneB].filter((id): id is string => id !== null)),
    );
    const poll = async () => {
      const entries = await Promise.all(
        visibleIds.map(async (id) => {
          try {
            const dir = await invoke<string | null>("pty_cwd", { id });
            return [id, dir] as const;
          } catch {
            return [id, null] as const;
          }
        }),
      );
      if (cancelled) return;
      setLiveCwds((prev) => {
        // Merge onto prior values so hidden tabs keep their last-known cwd.
        let next: Map<string, string> | null = null;
        for (const [id, dir] of entries) {
          if (dir && prev.get(id) !== dir) {
            if (!next) next = new Map(prev);
            next.set(id, dir);
          }
        }
        return next ?? prev;
      });
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 2500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [paneA, paneB]);

  // The project directory behind each tab's label, in tab order. Hoisted out of
  // the bar-building memo below because the repo marks need it one step
  // earlier — `useRepoIcons` resolves per directory, and a hook can't be called
  // from inside a `useMemo` callback.
  const tabDirs = useMemo(
    () => tabs.map((t) => tabProjectDir(liveCwds.get(t.id) ?? t.cwd, homePath)),
    [tabs, liveCwds, homePath],
  );
  // Cached per directory for the session, so this is a map read per render and
  // not an `invoke`.
  const repoIcons = useRepoIcons(tabDirs);

  // Project-aware labels: basename of the tab's live cwd ($HOME / root →
  // "zsh"), numbered per project in tab order — "redline 1, redline 2, zsh 1".
  // Derived at render, so close/reorder/cd all renumber automatically. Each
  // also carries its repo's mark, which is anchored to the repo rather than the
  // directory: `cd src` inside redline flips the label to "src" and keeps the
  // redline logo.
  //
  // Memoized over exactly the inputs above: the strip and the bubbles are
  // props of memoized children, and rebuilding these arrays on every render
  // would hand them fresh identities and defeat that.
  const { barTabs, repoBubbles } = useMemo(() => {
    const labelCounts = new Map<string, number>();
    // Built in the same pass as the bar's tabs so the bubbles' popover rows
    // carry exactly the label the tab strip shows — one numbering, one source.
    const terminalRefs: TerminalRef[] = [];
    const nextTabs = tabs.map((t, i) => {
      const projectDir = tabDirs[i] ?? null;
      const label = tabBaseLabel(projectDir);
      const n = (labelCounts.get(label) ?? 0) + 1;
      labelCounts.set(label, n);
      // A held terminal that IS on screen already carries its own strip; flag
      // only the ones you can't see, so a background hold is still discoverable.
      const onScreen = !collapsed && (t.id === paneA || t.id === paneB);
      const title = `${label} ${n}`;
      const dir = liveCwds.get(t.id) ?? t.cwd;
      terminalRefs.push({
        id: t.id,
        dir,
        label: title,
        // What this one is *working on*: the plan it's holding for review, else
        // whatever it announced as its window title — minus the cwd echoes
        // every shell writes, which the row's location line already says.
        work:
          workSignal(heldPlanTitles?.get(t.id), termTitles.get(t.id), dir)
            ?.text ?? null,
        held: heldTerminalIds?.has(t.id) ?? false,
        unseen: unseen.has(t.id),
        // Same "really visible" test as the held marker: with the dock
        // collapsed a pane's tab isn't on screen, so the popover shouldn't
        // claim it is.
        pane: !onScreen ? null : t.id === paneA ? "A" : "B",
      });
      const resolved =
        projectDir === null ? undefined : repoIcons.get(projectDir);
      // The mark says which repo, the label says which folder. Surface the
      // resolved root in the tooltip only when the two disagree — otherwise it
      // would just repeat the label back at you.
      const repoName = resolved?.name ?? "";
      return {
        id: t.id,
        title,
        held: !onScreen && (heldTerminalIds?.has(t.id) ?? false),
        icon: iconFor(resolved, label),
        repoRoot:
          resolved && repoName && repoName !== label
            ? tildeify(resolved.root, homePath)
            : undefined,
      };
    });
    // Recent repos, each carrying the terminals already open in it.
    return {
      barTabs: nextTabs,
      repoBubbles: groupTerminals(
        orderRepos(projectOptions ?? [], recentDirs, homePath, MAX_BUBBLES),
        terminalRefs,
        homePath,
      ),
    };
  }, [
    tabs,
    tabDirs,
    repoIcons,
    liveCwds,
    homePath,
    collapsed,
    paneA,
    paneB,
    heldTerminalIds,
    heldPlanTitles,
    termTitles,
    unseen,
    projectOptions,
    recentDirs,
  ]);

  // Clicking a bubble always opens a *new* terminal there (picking an existing
  // one is what the popover is for), lands `claude` in it, and bumps the repo
  // to the front of the strip. The point of the bubble is the whole errand —
  // "work on that repo" — not a bare shell you then have to launch from; it is
  // the "here + Claude" action aimed at a repo instead of the focused tab, so
  // it uses the same spawn → 900ms → write pattern (let the shell's rc files
  // settle before the command lands). Every effect lives in the handler, never
  // in a setTabs updater — StrictMode double-invokes those (see closeTab).
  const openRepoTerminal = (path: string) => {
    setRecentDirs((prev) => bumpMru(prev, path, MAX_BUBBLES));
    const id = addTab(path);
    window.setTimeout(() => {
      void invoke("pty_write", { id, data: "claude --permission-mode plan\r" });
    }, 900);
  };

  // Position each tab's wrapper by its pane role using CSS only — never by
  // moving it to a different JSX parent, which would unmount/remount the
  // TerminalView and kill its PTY. Hidden tabs stack full-bleed (their own
  // display:none keeps them off screen).
  //
  // Resting geometry. The live drag overwrites `width`/`left` on the tagged
  // elements directly (see `applySplitRatio`), so dragging the inner divider
  // re-lays out the panes and both tab strips without a single React render,
  // and no TerminalView is reconciled mid-drag.
  const pctA = `${splitRatio * 100}%`;
  const wrapperStyle = (role: "A" | "B" | null): CSSProperties => {
    const base: CSSProperties = { position: "absolute", top: 0, bottom: 0 };
    if (!split || role === null) return { ...base, left: 0, right: 0 };
    if (role === "A") return { ...base, left: 0, width: pctA };
    return { ...base, left: pctA, right: 0 };
  };
  /** Tag a pane wrapper so the live path can position it. */
  const splitAttrs = (role: "A" | "B" | null) =>
    !split || role === null ? {} : role === "A" ? { [SPLIT_A]: "" } : { [SPLIT_B]: "" };

  // Shared action-button wiring, reused by whichever strip carries the actions.
  //
  // The handlers close over live state, so they change identity on every
  // render — which would defeat TerminalTabBar's memo entirely. They're routed
  // through a ref instead, leaving this object dependent only on the VALUES the
  // bar actually renders from.
  const handlersRef = useRef({
    addTab,
    addTabHere,
    addTabHereClaude,
    toggleSplit,
    onFullscreenChange,
    fullscreen,
    closeTab,
    reorderTabs,
    openRepoTerminal,
    selectTab,
  });
  handlersRef.current = {
    addTab,
    addTabHere,
    addTabHereClaude,
    toggleSplit,
    onFullscreenChange,
    fullscreen,
    closeTab,
    reorderTabs,
    openRepoTerminal,
    selectTab,
  };
  const stableHandlers = useMemo(
    () => ({
      onNew: () => handlersRef.current.addTab(null),
      onNewHere: () => handlersRef.current.addTabHere(),
      onNewHereClaude: () => handlersRef.current.addTabHereClaude(),
      onToggleSplit: () => handlersRef.current.toggleSplit(),
      onToggleFullscreen: () =>
        handlersRef.current.onFullscreenChange(!handlersRef.current.fullscreen),
      onClose: (id: string) => handlersRef.current.closeTab(id),
      onReorder: (from: number, to: number) =>
        handlersRef.current.reorderTabs(from, to),
      onOpenRepo: (path: string) => handlersRef.current.openRepoTerminal(path),
      onFocusTerminal: (id: string) => handlersRef.current.selectTab(id),
    }),
    [],
  );
  const barActions = useMemo(
    () => ({ fullscreen, split, repoBubbles, ...stableHandlers }),
    [fullscreen, split, repoBubbles, stableHandlers],
  );

  return (
    <div
      data-tour="terminal"
      className="flex flex-col h-full"
      ref={rootRef}
    >
      {/* The strip and the divider are the risky render regions (drag math);
          they get their own boundaries so a crash there can never unmount the
          TerminalViews below — unmounting a TerminalView kills its PTY. */}
      <ErrorBoundary
        region="terminal tab bar"
        fallback={(_err, reset) => (
          <div
            className="flex items-center gap-2 px-3 shrink-0"
            style={{
              height: "30px",
              borderBottom: "1px solid var(--color-rule)",
              background: "var(--color-bg-elevated)",
              color: "var(--color-ink-muted)",
              fontSize: "12px",
            }}
          >
            <span>Tab bar hit a rendering error — terminals are unaffected.</span>
            <button
              type="button"
              onClick={reset}
              style={{ textDecoration: "underline", cursor: "pointer" }}
            >
              Reload tab bar
            </button>
          </div>
        )}
      >
      {split && paneB ? (
        // One tab strip per pane, aligned over its pane so a split session's
        // tab indicator sits above the pane it's actually running in.
        <div className="flex items-stretch shrink-0">
          <div
            {...{ [SPLIT_A]: "" }}
            style={{
              width: pctA,
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
      </ErrorBoundary>
      <div ref={paneContainerRef} className="flex-1 relative">
        {tabs.map((t) => {
          const role: "A" | "B" | null =
            t.id === paneA ? "A" : t.id === paneB ? "B" : null;
          return (
            <div
              key={t.id}
              {...splitAttrs(role)}
              style={wrapperStyle(role)}
            >
              <TerminalView
                id={t.id}
                cwd={t.cwd}
                theme={theme}
                visible={role !== null && !collapsed}
                onActivity={handleActivity}
                onExit={handleExit}
                onTitle={handleTitle}
                onPaneFocus={
                  role === "A" ? focusPaneA : role === "B" ? focusPaneB : undefined
                }
              />
              {role !== null &&
                !collapsed &&
                heldTerminalIds?.has(t.id) && <InterceptStrip />}
            </div>
          );
        })}
        {split && (
          // Null fallback: a crashed divider just disappears (toggle the
          // split off/on to get it back); the panes keep their shells.
          <ErrorBoundary fallback={() => null}>
            <TerminalSplitDivider
              ratio={splitRatio}
              onRatioChange={setSplitRatio}
              containerRef={paneContainerRef}
              onLiveRatio={applySplitRatio}
            />
          </ErrorBoundary>
        )}
      </div>
      {showCloseConfirm && (
        <CloseConfirmModal
          onConfirm={() => {
            // destroy() bypasses the onCloseRequested guard we set above —
            // and normal unmount teardown with it, so kill the shells first
            // rather than leaving orphans to outlive the window.
            void invoke("pty_kill_all")
              .catch(() => {})
              .finally(() => void getCurrentWindow().destroy());
          }}
          onCancel={() => setShowCloseConfirm(false)}
        />
      )}
    </div>
  );
  },
  ),
);
