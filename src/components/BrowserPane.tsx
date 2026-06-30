// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Window } from "@tauri-apps/api/window";
import { Webview } from "@tauri-apps/api/webview";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { usePersistedState } from "../theme/usePersistedState";
import { resolveOmniboxInput } from "../lib/omnibox";
import type {
  BrowseFocusTabEvent,
  BrowseOpenTabEvent,
  BrowseWakeTabEvent,
  Mission,
} from "../types";
import { SplitPane } from "./SplitPane";
import { BrowserChat } from "./BrowserChat";
import { MissionChat } from "./MissionChat";
import { MissionStartDialog } from "./MissionStartDialog";
import { useMission } from "../hooks/useMission";

// A native child webview is an OS-level layer painted on top of the React DOM —
// it does not flow inline. So this component renders an invisible placeholder
// ("slot") and syncs the *active* tab's webview position/size to that slot's
// bounding rect. Each tab is its own native child webview (label `browser-<id>`),
// with only the active one shown. Unlike an <iframe>, a real child webview loads
// any site (no X-Frame-Options blocking) and is scriptable from Rust via
// webview.eval(...).
//
// To bound memory, at most `MAX_LIVE_WEBVIEWS` webviews are kept alive (the
// active tab + the most-recently-used others); idle background tabs are
// *suspended* — their DOM snapshot + scroll are cached (backend `SnapshotCache`)
// and the webview destroyed to reclaim its WebContent process. A suspended tab
// stays in the list and remains discussable (served from the cache) and drivable
// (a query/action wakes it in the background). `liveIntentRef` tracks which tabs
// should have a webview; `mruRef` is the recency order that picks suspend victims.
const HOME = "https://www.google.com";
const MAX_TABS = 10;
// Cap on simultaneously-live native webviews (active + MRU). The rest are
// suspended to the snapshot cache. Tunable.
const MAX_LIVE_WEBVIEWS = 3;
// The embedded WKWebView's default user-agent omits the "Safari" token, so
// sites (Google included) serve a legacy/basic layout. Presenting a current
// Safari UA makes them serve the modern experience the engine can render.
const SAFARI_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15";

// Native webviews are expensive OS resources, and React StrictMode mounts →
// unmounts → remounts effects synchronously in dev (a fast toggle off/on does
// the same). Destroying and recreating the webviews on every such cycle is
// what caused the pane to go black. So teardown is DEFERRED and cancellable at
// module scope (only one BrowserPane is ever mounted — it's the document pane):
// a remount within the grace window cancels the pending close, and tabs are
// reused by label via Webview.getByLabel(...) rather than recreated. A real
// close (toggle off, no remount) lets the timer fire and frees the webviews.
const TEARDOWN_GRACE_MS = 150;
let pendingTeardown = 0;

// View filters injected as a document-start user script in the native webview
// (see browser_set_view in Rust), so they're applied before the page paints —
// no flicker across navigation, and no browser extension to install/toggle.
// "dark" is a universal smart-invert: invert + hue-rotate the page, then
// re-invert media so photos/videos read normally. The rest are plain filters.
const VIEW_CSS: Record<string, string> = {
  none: "",
  dark:
    "html{-webkit-filter:invert(100%) hue-rotate(180deg);filter:invert(100%) hue-rotate(180deg);background:#fafafa!important}" +
    "img,picture,video,canvas,svg,iframe,embed,object,[style*=\"background-image\"],[class*=\"logo\"]{-webkit-filter:invert(100%) hue-rotate(180deg);filter:invert(100%) hue-rotate(180deg)}",
  sepia: "html{-webkit-filter:sepia(.6) contrast(.95) brightness(.96);filter:sepia(.6) contrast(.95) brightness(.96)}",
  gray: "html{-webkit-filter:grayscale(1);filter:grayscale(1)}",
  dim: "html{-webkit-filter:brightness(.75) contrast(1.05);filter:brightness(.75) contrast(1.05)}",
  contrast: "html{-webkit-filter:contrast(1.25);filter:contrast(1.25)}",
};
const cssForView = (mode: string): string => VIEW_CSS[mode] ?? "";

// Destroy a tab's native webview AND stop its audio/video. A bare
// Webview.close() can leave WKWebView's media session alive — a YouTube tab
// keeps playing in the background with no visible tab — so every teardown path
// routes through the native browser_close, which pauses/detaches all media
// before closing the webview.
const closeWebview = (label: string): void => {
  void invoke("browser_close", { label }).catch(() => {});
};

interface Tab {
  id: string;
  /** Native webview label — `browser-${id}`. */
  label: string;
  url: string;
  /** Display label for the tab strip (derived host). */
  title: string;
  /** Stable id for this tab's browse-agent discussion thread. Survives reload
   *  (persisted with the tab list) and the recreated native webview, so a tab's
   *  conversation reattaches to it. */
  browseId: string;
}

// Persisted tab list — so a tab's browse-agent thread (keyed by `browseId`)
// reattaches after a reload. The native webview itself is recreated fresh at
// the saved URL; only url/title/browseId need to survive.
const TABS_KEY = "redline.browser.tabs";
const newBrowseId = (): string =>
  typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `b-${Date.now()}-${Math.random().toString(36).slice(2)}`;

const freshHomeTab = (): Tab => ({
  id: "t0",
  label: "browser-t0",
  url: HOME,
  title: hostnameOf(HOME),
  browseId: newBrowseId(),
});

function loadTabs(): Tab[] {
  try {
    const raw = localStorage.getItem(TABS_KEY);
    if (raw) {
      const arr = JSON.parse(raw) as Partial<Tab>[];
      if (Array.isArray(arr) && arr.length) {
        return arr
          .filter((t) => typeof t.id === "string" && typeof t.url === "string")
          .map((t) => ({
            id: t.id as string,
            label: `browser-${t.id}`,
            url: t.url as string,
            title: t.title || hostnameOf(t.url as string),
            browseId: t.browseId || newBrowseId(),
          }));
      }
    }
  } catch {
    /* fall through to a fresh tab */
  }
  return [freshHomeTab()];
}

/** Next free `t<n>` sequence above any restored ids, so a new tab can't collide
 *  with a restored one. */
function nextSeq(tabs: Tab[]): number {
  let max = 0;
  for (const t of tabs) {
    const n = Number(t.id.replace(/^t/, ""));
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max + 1;
}

interface Bookmark {
  title: string;
  url: string;
}

interface BrowserPaneProps {
  /** Close the browser (toggle it off). */
  onClose: () => void;
  /** When false (e.g. a modal/overlay covers the pane), the native webview is
   *  hidden so it doesn't paint over the overlay. Defaults to true. */
  visible?: boolean;
  /** Active file-explorer folder, if one is open — passed to the page-discussion
   *  agent as its working directory. */
  projectDir?: string | null;
  /** Ship a page-discussion reply into a fresh Redline plan session (terminal +
   *  `claude --permission-mode plan`). Forwarded to the chat's per-reply action. */
  onSendToRedline?: (markdown: string) => void;
  /** Seed the Prompt Drafter with a synthesized mission brief (markdown → Tiptap
   *  doc), so the user shapes the real document and ships it to Claude Code. */
  onSynthesizeToDrafter?: (markdown: string) => void;
  /** Opaque token that changes whenever a SURROUNDING App pane toggles (comment
   *  pane, sidebar, doc-split orientation/visibility). These reflow the slot
   *  without a drag — and a `ResizeObserver` on the slot doesn't reliably catch
   *  the resulting geometry shift — so the native webview must be re-synced when
   *  it changes. The value itself is never read, only its identity. */
  layoutKey?: string;
}

const hostnameOf = (u: string): string => {
  try {
    return new URL(u).hostname || u;
  } catch {
    return u;
  }
};

export function BrowserPane({
  onClose,
  visible = true,
  projectDir = null,
  onSendToRedline,
  onSynthesizeToDrafter,
  layoutKey,
}: BrowserPaneProps) {
  const slotRef = useRef<HTMLDivElement | null>(null);
  // id → live Webview handle. Kept in a ref (not state) because these are
  // native resources we create/destroy imperatively, not render outputs.
  const wvMapRef = useRef<Map<string, Webview>>(new Map());
  const creatingRef = useRef<Set<string>>(new Set());
  // Per-tab count of consecutive failed webview-creation attempts, so the
  // reconcile retry backs off and eventually gives up instead of spinning.
  // Reset to 0 the moment a webview is created successfully.
  const wakeAttemptsRef = useRef<Map<string, number>>(new Map());
  // Restore the persisted tab list once (stable across renders), and seed the
  // new-tab sequence above any restored id.
  const initialTabsRef = useRef<Tab[] | null>(null);
  if (!initialTabsRef.current) initialTabsRef.current = loadTabs();
  const seqRef = useRef(nextSeq(initialTabsRef.current));
  // Which tab ids should have a live webview, and the recency order used to pick
  // suspend victims. Seeded with only the active tab — other restored tabs are
  // created lazily on first activation/wake (so reopening 8 tabs spawns 1 webview,
  // not 8). The reconcile effect only materializes tabs in `liveIntentRef`.
  const liveIntentRef = useRef<Set<string>>(
    new Set([initialTabsRef.current[0].id]),
  );
  const mruRef = useRef<string[]>([initialTabsRef.current[0].id]);
  const rafRef = useRef(0);
  // Last bounds pushed to the active webview, so we skip redundant native
  // setPosition/setSize calls when nothing actually moved. Cleared (set null)
  // whenever the active webview changes or is hidden, to force a re-apply.
  const lastRectRef = useRef<{ x: number; y: number; w: number; h: number } | null>(
    null,
  );
  // True while the user is editing the URL field, so polling doesn't clobber
  // what they're typing.
  const addrFocusedRef = useRef(false);

  // Debounced per-tab snapshot caching. Keeps the backend `SnapshotCache` fresh
  // (one debounce timer per tab id) so the browse agent can read / discuss a tab
  // even when its webview is later suspended or gone. Fired on navigation and
  // when a tab is backgrounded.
  const snapTimersRef = useRef<Map<string, number>>(new Map());
  const scheduleCacheSnapshot = useCallback((id: string, delay = 800) => {
    const timers = snapTimersRef.current;
    const prev = timers.get(id);
    if (prev) window.clearTimeout(prev);
    timers.set(
      id,
      window.setTimeout(() => {
        timers.delete(id);
        void invoke("browser_cache_snapshot", {
          label: `browser-${id}`,
        }).catch(() => {});
      }, delay),
    );
  }, []);
  // Stable handle so the `[]`-dep poll/effects can call the latest scheduler.
  const scheduleCacheRef = useRef(scheduleCacheSnapshot);
  scheduleCacheRef.current = scheduleCacheSnapshot;
  // Clear any pending snapshot timers on unmount.
  useEffect(
    () => () => {
      for (const t of snapTimersRef.current.values()) window.clearTimeout(t);
      snapTimersRef.current.clear();
    },
    [],
  );

  // Bumped whenever `liveIntentRef` gains a tab, to re-run the reconcile effect
  // and materialize that tab's webview (refs alone don't trigger effects).
  const [liveVersion, setLiveVersion] = useState(0);
  // Mark a tab as wanting a live webview (idempotent). Triggers reconcile.
  const markLive = useCallback((id: string) => {
    if (!liveIntentRef.current.has(id)) {
      liveIntentRef.current.add(id);
      setLiveVersion((v) => v + 1);
    }
  }, []);
  // Like markLive, but also kicks reconcile when the tab has NO live webview
  // right now — healing a tab whose webview died or whose creation failed.
  // markLive alone is a silent no-op once the id is in `liveIntentRef`, so a
  // tab stuck in that state (in liveIntent, but absent from `wvMapRef`) would
  // stay blank forever, unrecoverable by re-clicking or refreshing. This is the
  // wake path for any user action that should make a tab live and visible.
  const ensureLive = useCallback((id: string) => {
    liveIntentRef.current.add(id);
    if (!wvMapRef.current.has(id) && !creatingRef.current.has(id)) {
      wakeAttemptsRef.current.delete(id); // user action → fresh retry budget
      setLiveVersion((v) => v + 1);
    }
  }, []);
  // Move a tab to the front of the recency order (most-recently-used first).
  const touchMru = useCallback((id: string) => {
    mruRef.current = [id, ...mruRef.current.filter((x) => x !== id)];
  }, []);

  const [tabs, setTabs] = useState<Tab[]>(initialTabsRef.current);
  const [activeId, setActiveId] = useState(() => initialTabsRef.current![0].id);
  // Which tab's DISCUSSION thread the chat pane shows. Normally equals activeId,
  // but they diverge when the agent opens a tab on the user's behalf: the new
  // tab becomes the visible/active page (activeId), while the conversation stays
  // anchored to the tab it was started from (discussionId) so the in-flight
  // reply isn't interrupted and the one conversation keeps driving the new tab.
  // Any manual tab click re-couples them (see selectTab).
  const [discussionId, setDiscussionId] = useState(
    () => initialTabsRef.current![0].id,
  );
  const [addr, setAddr] = useState(() => initialTabsRef.current![0].url);
  // Page-discussion panel (browse agent). Open state is in-session; the panel
  // splits the webview slot when open. The thread itself persists in the DB.
  const [chatOpen, setChatOpen] = useState(false);
  // Which discussion the split shows: the per-tab "page" chat or the mission
  // "orchestrator" chat (a tier above). The 💬/🎯 toolbar buttons set this.
  const [chatTab, setChatTab] = useState<"page" | "mission">("page");
  // Research-mission state (active mission, its pins, the resumable list).
  // Mirrors itself to the backend so the daemon's /v1/mission/* routes can
  // answer the orchestrator. See useMission.
  const mission = useMission();
  // The "Start a mission" / "what's our goal" dialog.
  const [missionDialogOpen, setMissionDialogOpen] = useState(false);
  const [missionMenuOpen, setMissionMenuOpen] = useState(false);
  // The ▾ missions menu rides beside 🎯 only once at least one mission exists to
  // manage (switch / resume / delete / start another). With none, the bare 🎯
  // is "start a mission" and the caret would be a dead control.
  const missionShowMenu = mission.missions.length > 0;
  // The active mission id, readable inside the `[tabs]`-keyed persistence effect
  // and the swap callbacks without adding mission state to their deps.
  const activeMissionIdRef = useRef<string | null>(null);
  activeMissionIdRef.current = mission.activeMission?.missionId ?? null;
  // True during a full workspace swap, so the persistence effect doesn't write
  // the transient mid-swap tab state to a bucket.
  const swappingRef = useRef(false);
  // Mount-time mission-tab restore runs at most once.
  const initDoneRef = useRef(false);
  // Debounce timer for saving the active mission's tab workspace.
  const missionTabsTimerRef = useRef<number | null>(null);
  const [chatRatio, setChatRatio] = usePersistedState<number>(
    "redline.browser.chatRatio",
    0.62,
  );
  // While dragging the chat divider, hide the native webview so it doesn't
  // swallow the pointer (same rule App uses for its document/browser split).
  const [chatDragging, setChatDragging] = useState(false);
  // True while a page is "in-window fullscreen" (a video player's fullscreen
  // button, faked by the injected shim which sets window.__redline_fs). Polled
  // from the active tab; when on, the slot expands to fill the whole window.
  const [browserFullscreen, setBrowserFullscreen] = useState(false);
  const [bookmarks, setBookmarks] = usePersistedState<Bookmark[]>(
    "redline.browser.bookmarks",
    [],
  );
  // Active view filter ("none" | "dark" | "sepia" | "gray" | "dim" | "contrast"),
  // applied to every tab and remembered across sessions.
  const [viewMode, setViewMode] = usePersistedState<string>(
    "redline.browser.viewMode",
    "none",
  );
  const viewModeRef = useRef(viewMode);
  viewModeRef.current = viewMode;
  // Bookmarks open as a NATIVE popup menu (HTML can't overlay a native
  // webview). Item clicks arrive as a `bookmark-menu-action` event; the
  // handler reads these refs to stay current without re-subscribing.
  const bookmarksRef = useRef(bookmarks);
  bookmarksRef.current = bookmarks;

  // Mirror state into refs so the async webview callbacks read current values.
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const discussionIdRef = useRef(discussionId);
  discussionIdRef.current = discussionId;
  // The native webview is hidden whenever the pane is logically hidden, the
  // chat divider is being dragged, or an HTML overlay we own is up (the mission
  // start dialog / menu) — a native webview paints OVER React DOM, so it must
  // step aside for those, the same reason bookmarks use a native popup menu.
  const effectiveVisible =
    visible && !chatDragging && !missionDialogOpen && !missionMenuOpen;
  const visibleRef = useRef(effectiveVisible);
  visibleRef.current = effectiveVisible;

  // Persist the tab list (url/title/browseId) so a tab's discussion thread
  // reattaches after reload, and mirror it into the backend so the browse
  // agent's `/v1/browser/tabs` registry + cross-tab routes can resolve a tab
  // selector to a webview label / discussion thread.
  useEffect(() => {
    // Suppress while a workspace swap is mid-flight (the swap saves buckets
    // explicitly; persisting the transient state would cross-contaminate them).
    if (!swappingRef.current) {
      const descs = tabs.map((t) => ({
        id: t.id,
        url: t.url,
        title: t.title,
        browseId: t.browseId,
      }));
      const mid = activeMissionIdRef.current;
      if (mid) {
        // A mission owns this workspace → persist to it (debounced SQLite write).
        if (missionTabsTimerRef.current) window.clearTimeout(missionTabsTimerRef.current);
        missionTabsTimerRef.current = window.setTimeout(() => {
          void mission.setMissionTabs(mid, descs);
        }, 500);
      } else {
        // Regular browsing → the global bucket.
        try {
          localStorage.setItem(TABS_KEY, JSON.stringify(descs));
        } catch {
          /* ignore — tabs still work in-memory */
        }
      }
    }
    // Always mirror the live tab list to the daemon, so the orchestrator and
    // page agents see the current tabs (independent of which bucket persists).
    void invoke("browser_set_tabs", {
      list: tabs.map((t) => ({
        id: t.id,
        label: t.label,
        url: t.url,
        title: t.title,
        browseId: t.browseId,
      })),
    }).catch(() => {});
  }, [tabs]);

  // Mirror the active tab into the backend so the browse agent's
  // `/v1/browser/*` daemon routes act on the tab the user is looking at.
  useEffect(() => {
    void invoke("browser_set_active", { label: `browser-${activeId}` }).catch(
      () => {},
    );
  }, [activeId]);
  // Clear it when the browser pane goes away.
  useEffect(
    () => () => {
      void invoke("browser_set_active", { label: null }).catch(() => {});
    },
    [],
  );

  const activeUrl = tabs.find((t) => t.id === activeId)?.url ?? "";
  const activeUrlRef = useRef(activeUrl);
  activeUrlRef.current = activeUrl;
  const isBookmarked = bookmarks.some((b) => b.url === activeUrl);

  // Position + show the active tab's webview over the slot; nothing else.
  const syncBounds = useCallback(() => {
    const el = slotRef.current;
    const active = wvMapRef.current.get(activeIdRef.current);
    if (!el || !active) return;
    const r = el.getBoundingClientRect();
    // Sliver / hidden-under-overlay: hide rather than zero-size.
    if (!visibleRef.current || r.width < 2 || r.height < 2) {
      void active.hide();
      lastRectRef.current = null; // re-apply bounds on next show
      return;
    }
    const next = {
      x: Math.round(r.left),
      y: Math.round(r.top),
      w: Math.round(r.width),
      h: Math.round(r.height),
    };
    const prev = lastRectRef.current;
    void active.show();
    // Only touch the native webview when the rect actually changed — redundant
    // setPosition/setSize calls force WKWebView relayout and cause jank.
    if (!prev || prev.x !== next.x || prev.y !== next.y) {
      void active.setPosition(new LogicalPosition(next.x, next.y));
    }
    if (!prev || prev.w !== next.w || prev.h !== next.h) {
      void active.setSize(new LogicalSize(next.w, next.h));
    }
    lastRectRef.current = next;
  }, []);

  // Coalesce the rapid bursts a divider drag produces into one update/frame.
  const scheduleSync = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      syncBounds();
    });
  }, [syncBounds]);

  const ensureTab = useCallback(
    async (tab: Tab, win: Window): Promise<Webview> => {
      // Reuse an existing webview with this label if one is still alive (a
      // StrictMode remount or cancelled teardown left it around) — recreating
      // it would either flash or error on the duplicate label.
      const existing = await Webview.getByLabel(tab.label).catch(() => null);
      if (existing) return existing;
      const el = slotRef.current;
      const r = el?.getBoundingClientRect();
      const opts = {
        url: tab.url,
        x: Math.round(r?.left ?? 0),
        y: Math.round(r?.top ?? 0),
        width: Math.max(1, Math.round(r?.width ?? 800)),
        height: Math.max(1, Math.round(r?.height ?? 600)),
        acceptFirstMouse: true,
        userAgent: SAFARI_UA,
      };
      const create = async (): Promise<Webview> => {
        const w = new Webview(win, tab.label, opts);
        await new Promise<void>((resolve, reject) => {
          w.once("tauri://created", () => resolve());
          w.once("tauri://error", (e) => reject(e));
        });
        return w;
      };
      // A just-suspended tab's webview may still be mid-teardown (close() is
      // async); recreating the same live label would throw. If creation fails,
      // wait for the old webview to actually disappear, then retry once.
      let wv: Webview;
      try {
        wv = await create();
      } catch (firstErr) {
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          const still = await Webview.getByLabel(tab.label).catch(() => null);
          if (!still) break;
          await new Promise((res) => window.setTimeout(res, 80));
        }
        try {
          wv = await create();
        } catch {
          throw firstErr;
        }
      }
      // Native-only: turn on two-finger back/forward swipe (off by default).
      void invoke("browser_enable_gestures", { label: tab.label }).catch(
        () => {},
      );
      // Native-only: let macOS resize this webview with the window (smooth
      // fullscreen/resize instead of laggy per-frame IPC repositioning).
      void invoke("browser_enable_autoresize", { label: tab.label }).catch(
        () => {},
      );
      // Native-only: install the in-window fullscreen shim (so a video player's
      // fullscreen button fills the app window instead of being ignored). Also
      // re-installed by browser_set_view alongside any view filter.
      void invoke("browser_install_shims", { label: tab.label }).catch(() => {});
      return wv;
    },
    [],
  );

  // Reconcile native webviews against the tab list: create the tabs that *want*
  // a live webview (`liveIntentRef`), close orphaned. A tab in the list but not
  // in `liveIntentRef` is suspended (no webview) — left alone here. Creation is
  // async and guarded against StrictMode double-mount.
  useEffect(() => {
    const win = Window.getCurrent();
    for (const tab of tabs) {
      if (
        !liveIntentRef.current.has(tab.id) ||
        wvMapRef.current.has(tab.id) ||
        creatingRef.current.has(tab.id)
      ) {
        continue;
      }
      creatingRef.current.add(tab.id);
      ensureTab(tab, win)
        .then((wv) => {
          creatingRef.current.delete(tab.id);
          // Tab was closed while we were creating — discard.
          if (!tabsRef.current.some((t) => t.id === tab.id)) {
            closeWebview(tab.label);
            return;
          }
          wvMapRef.current.set(tab.id, wv);
          wakeAttemptsRef.current.delete(tab.id); // created → clear retry count
          // Carry the active view filter onto the freshly created tab so new
          // tabs match the others (the user script makes it survive navigation).
          if (viewModeRef.current !== "none") {
            void invoke("browser_set_view", {
              label: tab.label,
              css: cssForView(viewModeRef.current),
            }).catch(() => {});
          }
          // If this tab was suspended, restore its scroll once the page loads.
          // There's no load event, so retry the scrollTo a few times.
          void invoke<[number, number] | null>("browser_consume_scroll", {
            label: tab.label,
          })
            .then((pos) => {
              if (!pos) return;
              const [sx, sy] = pos;
              let tries = 0;
              const apply = () => {
                void invoke("browser_eval", {
                  label: tab.label,
                  script: `(function(){try{window.scrollTo(${sx},${sy});}catch(e){}})()`,
                }).catch(() => {});
                if (++tries < 6) window.setTimeout(apply, 300);
              };
              apply();
            })
            .catch(() => {});
          if (tab.id === activeIdRef.current) {
            lastRectRef.current = null; // newly active webview — apply bounds
            syncBounds();
          } else void wv.hide();
        })
        .catch((e) => {
          creatingRef.current.delete(tab.id);
          console.error("browser tab webview failed to create", e);
          // Don't strand the tab blank: a failed create is usually the prior
          // webview for this label still tearing down (suspend's close() is
          // async). Retry a bounded number of times by re-running reconcile;
          // selectTab/navigate also re-trigger this on user action. Give up
          // after a few tries so a genuinely broken tab can't spin forever.
          const n = (wakeAttemptsRef.current.get(tab.id) ?? 0) + 1;
          wakeAttemptsRef.current.set(tab.id, n);
          if (n <= 3 && tabsRef.current.some((t) => t.id === tab.id)) {
            window.setTimeout(() => setLiveVersion((v) => v + 1), 300 * n);
          }
        });
    }
    for (const [id] of [...wvMapRef.current]) {
      if (!tabs.some((t) => t.id === id)) {
        wvMapRef.current.delete(id);
        liveIntentRef.current.delete(id);
        closeWebview(`browser-${id}`);
      }
    }
  }, [tabs, liveVersion, ensureTab, syncBounds]);

  // Enforce the live-webview budget: keep the active tab + the most-recently-used
  // others (up to MAX_LIVE_WEBVIEWS), suspend the rest. Suspension caches the
  // tab's snapshot + scroll and destroys its webview; the tab stays in the list
  // (still discussable from the cache, woken on demand). Gated by
  // `browser_can_suspend` so we never drop the active tab, an in-flight agent
  // turn, or a tab playing media.
  const enforceLiveBudget = useCallback(() => {
    const active = activeIdRef.current;
    const keep = new Set(
      [active, ...mruRef.current.filter((id) => id !== active)].slice(
        0,
        MAX_LIVE_WEBVIEWS,
      ),
    );
    for (const [id] of [...wvMapRef.current]) {
      if (keep.has(id)) continue;
      void invoke<boolean>("browser_can_suspend", { label: `browser-${id}` })
        .then((ok) => {
          // Bail if it can't be suspended, became active, or is already gone.
          if (!ok || id === activeIdRef.current || !wvMapRef.current.has(id)) {
            return;
          }
          wvMapRef.current.delete(id);
          liveIntentRef.current.delete(id);
          void invoke("browser_suspend", { label: `browser-${id}` }).catch(
            () => {},
          );
        })
        .catch(() => {});
    }
  }, []);

  // On tab switch: snapshot the tab we're leaving, hide the others, reflect the
  // active URL in the bar, show the new one.
  const prevActiveIdRef = useRef(activeId);
  useEffect(() => {
    const leaving = prevActiveIdRef.current;
    // Capture the outgoing tab's snapshot before it's backgrounded, so it stays
    // discussable and ready to be suspended. Short delay.
    if (leaving && leaving !== activeId && wvMapRef.current.has(leaving)) {
      scheduleCacheRef.current(leaving, 100);
    }
    prevActiveIdRef.current = activeId;
    // The active tab must be live and most-recent; then trim the rest to budget.
    // `ensureLive` (not `markLive`) so an activation reached by any path — tab
    // close shifting focus, an agent opening a tab — also recreates a webview
    // that died or failed to materialize, instead of showing a blank pane.
    ensureLive(activeId);
    touchMru(activeId);
    enforceLiveBudget();
    for (const [id, wv] of wvMapRef.current) {
      if (id !== activeId) void wv.hide();
    }
    const t = tabsRef.current.find((x) => x.id === activeId);
    if (t) setAddr(t.url);
    lastRectRef.current = null; // different webview — force a position/size apply
    syncBounds();
  }, [activeId, ensureLive, touchMru, enforceLiveBudget, syncBounds]);

  // (Visibility/chat/divider reflows are handled by the active-tracking effect
  // below, which keys on effectiveVisible/chatOpen/chatRatio.)

  // Observe the slot for size changes. Keyed on `chatOpen` because toggling the
  // chat re-parents the slot div into/out of the SplitPane (a new DOM node), so
  // the observer must re-attach to keep the webview tracking the slot.
  useEffect(() => {
    const el = slotRef.current;
    if (!el) return;
    const ro = new ResizeObserver(scheduleSync);
    ro.observe(el);
    return () => ro.disconnect();
  }, [chatOpen, scheduleSync]);

  // The JS webview API surfaces no navigation events, so poll the active tab's
  // real URL to keep the address bar and tab title honest as the page navigates
  // (link clicks, redirects, search submits).
  useEffect(() => {
    const tick = async () => {
      // Skip while hidden under an overlay or the app is backgrounded — nothing
      // is visible to keep in sync, so don't pay the IPC + re-render cost.
      if (!visibleRef.current || document.hidden) return;
      const id = activeIdRef.current;
      if (!wvMapRef.current.has(id)) return;
      try {
        const url = await invoke<string>("browser_url", {
          label: `browser-${id}`,
        });
        if (!url || url === "about:blank") return;
        const changed = tabsRef.current.find((t) => t.id === id)?.url !== url;
        // Only re-key state when the URL actually moved — `ts.map` would
        // otherwise allocate a fresh array every poll tick (once a second) and
        // re-render the whole pane + discussion, which churns the chat DOM and
        // makes text selection in a reply flaky. Return `ts` to bail out.
        if (changed) {
          setTabs((ts) => {
            const i = ts.findIndex((t) => t.id === id);
            if (i === -1 || ts[i].url === url) return ts;
            const next = ts.slice();
            next[i] = { ...next[i], url, title: hostnameOf(url) };
            return next;
          });
        }
        // Page navigated — refresh its cached snapshot (debounced so a burst of
        // redirects collapses to one capture once the URL settles).
        if (changed) scheduleCacheRef.current(id);
        if (id === activeIdRef.current && !addrFocusedRef.current) {
          setAddr(url);
        }
      } catch {
        /* webview gone mid-poll — ignore */
      }
    };
    const interval = window.setInterval(tick, 1000);
    return () => window.clearInterval(interval);
  }, []);

  // Poll the active tab's in-window fullscreen flag (set by the injected shim
  // on the TOP frame for both watch-pages and the embed handshake). Reuses the
  // proven string-returning eval path — no new native plumbing. ~250ms keeps
  // the expand/restore responsive without churn.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      // Hidden/backgrounded: nothing to expand — drop out of fullscreen layout.
      if (!visibleRef.current || document.hidden) {
        setBrowserFullscreen(false);
        return;
      }
      const id = activeIdRef.current;
      if (!wvMapRef.current.has(id)) return;
      try {
        const r = await invoke<string>("browser_eval_result", {
          label: `browser-${id}`,
          script:
            '(function(){try{return window.__redline_fs?"1":"0"}catch(e){return "0"}})()',
        });
        if (!cancelled) setBrowserFullscreen(r === "1");
      } catch {
        /* webview gone mid-poll — ignore */
      }
    };
    const interval = window.setInterval(tick, 250);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  // The slot moves (in/out of a fixed full-window overlay) when fullscreen
  // toggles; re-sync the native webview to its new rect to be safe (the
  // ResizeObserver usually catches it, but the transition can race the relayout).
  useEffect(() => {
    scheduleSync();
  }, [browserFullscreen, scheduleSync]);

  // A surrounding App pane toggled (comment pane opened/closed, sidebar
  // collapsed, doc-split flipped, …). These reflow the slot WITHOUT a divider
  // drag, and the OS-composited webview — which always paints ON TOP of the
  // React DOM — is left stranded at its old rect: a gap of blank space when the
  // slot grows (closing the sidecar), or the page spilling OVER the appearing
  // pane when the slot shrinks (opening the sidecar).
  //
  // Any no-drag slot reflow — a surrounding App pane toggling (`layoutKey`:
  // comment pane, sidebar, doc-split) OR the page-discussion split opening/
  // closing/resizing (`chatOpen`/`chatRatio`) — moves the slot, and the
  // OS-composited webview (which always paints ON TOP of the React DOM) must
  // follow it: a gap when the slot grows, the page spilling over the chat pane
  // when it shrinks.
  //
  // These reflows can land a frame — or several — late, and the slot's
  // ResizeObserver doesn't reliably fire for them; sampling at fixed delays
  // missed the final size (webview short by a pane width, or overflowing the
  // chat). So instead of guessing when the layout settles, actively TRACK the
  // slot: clear the cache to force a first apply, then re-read its rect every
  // frame until it holds steady for a few frames (or a short budget elapses).
  // Each frame goes through the diffed syncBounds, so once the size stops
  // changing it stops issuing setSize — no redundant same-rect calls (which
  // flicker WKWebView black) and no hide()/show() (same reason).
  useEffect(() => {
    lastRectRef.current = null; // force the first position + size apply
    let raf = 0;
    let stableFrames = 0;
    let frames = 0;
    const tick = () => {
      // Hidden (overlay up, or mid-divider-drag): hide once and stop — there's
      // nothing to track, and spinning would just churn. Becoming visible again
      // re-runs this effect (effectiveVisible changed) and resumes tracking.
      if (!visibleRef.current) {
        syncBounds();
        return;
      }
      const before = lastRectRef.current;
      syncBounds();
      const after = lastRectRef.current;
      const unchanged =
        !!before &&
        !!after &&
        before.x === after.x &&
        before.y === after.y &&
        before.w === after.w &&
        before.h === after.h;
      stableFrames = unchanged ? stableFrames + 1 : 0;
      // Stop once the rect has held for ~5 frames, or after ~40 frames (~0.6s) —
      // long enough to outlast any pane open/close/resize reflow.
      if (stableFrames < 5 && frames++ < 40) {
        raf = requestAnimationFrame(tick);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [layoutKey, chatOpen, chatRatio, effectiveVisible, syncBounds]);

  // Listeners + deferred teardown. A pending teardown from a StrictMode
  // pseudo-unmount (or a fast toggle off/on) is cancelled here so the webviews
  // survive. On real unmount the close is scheduled, not immediate, giving a
  // remount a chance to cancel it.
  useEffect(() => {
    if (pendingTeardown) {
      clearTimeout(pendingTeardown);
      pendingTeardown = 0;
    }
    // Close any stray browser-* webviews left over from a prior instance that
    // aren't part of the current tab set (bounds leaks from fast toggles).
    void (async () => {
      const all = await Webview.getAll().catch(() => []);
      const ours = new Set(tabsRef.current.map((t) => t.label));
      for (const wv of all) {
        if (wv.label.startsWith("browser-") && !ours.has(wv.label)) {
          closeWebview(wv.label);
        }
      }
    })();

    // The slot only moves on pane/window resize (ResizeObserver + window
    // resize cover those). A capture-phase scroll listener fired on every
    // unrelated scroll in the app and churned native setPosition/setSize for
    // nothing, so it's intentionally not registered.
    const onWin = () => scheduleSync();
    window.addEventListener("resize", onWin);

    // macOS NATIVE fullscreen (and some maximise paths) don't reliably fire the
    // DOM `resize` event in this child-webview setup, so the browser webview
    // would stay stuck at its pre-fullscreen size while the React toolbar
    // resized fine. Tauri's window-level resize event DOES fire on those
    // transitions. Re-sync on it, plus a couple of trailing syncs — fullscreen
    // ANIMATES, so the final window size only lands a few hundred ms later.
    const trailing: number[] = [];
    const onNativeResize = () => {
      scheduleSync();
      trailing.forEach(clearTimeout);
      trailing.length = 0;
      trailing.push(
        window.setTimeout(scheduleSync, 250),
        window.setTimeout(scheduleSync, 600),
      );
    };
    let unResized: (() => void) | undefined;
    void Window.getCurrent()
      .onResized(onNativeResize)
      .then((un) => {
        unResized = un;
      })
      .catch(() => {});

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      window.removeEventListener("resize", onWin);
      trailing.forEach(clearTimeout);
      unResized?.();
      const map = wvMapRef.current;
      pendingTeardown = window.setTimeout(() => {
        pendingTeardown = 0;
        for (const id of map.keys()) closeWebview(`browser-${id}`);
        map.clear();
      }, TEARDOWN_GRACE_MS);
    };
  }, [scheduleSync]);

  // Foreground a tab. A user action (tab click, opening a tab) couples the
  // discussion to it; an AGENT-initiated open (`anchorDiscussion: true`) leaves
  // the discussion where it is, so the conversation that opened the tab keeps
  // streaming and keeps driving it.
  const selectTab = (id: string) => {
    // Selecting a suspended tab wakes it: ensure it has a live webview (recreate
    // if its prior one died or never materialized), and bump its recency.
    ensureLive(id);
    touchMru(id);
    setActiveId(id);
    setDiscussionId(id);
  };

  const openTab = (
    url: string = HOME,
    opts: { anchorDiscussion?: boolean } = {},
  ) => {
    if (tabsRef.current.length >= MAX_TABS) return;
    const id = `t${seqRef.current++}`;
    const tab: Tab = {
      id,
      label: `browser-${id}`,
      url,
      title: hostnameOf(url),
      browseId: newBrowseId(),
    };
    markLive(id);
    touchMru(id);
    setTabs((ts) => [...ts, tab]);
    setActiveId(id);
    // Move the conversation onto the new tab unless an agent opened it on behalf
    // of the current conversation (then it stays anchored to its origin tab).
    if (!opts.anchorDiscussion) setDiscussionId(id);
  };

  const closeTab = (id: string) => {
    const remaining = tabsRef.current.filter((t) => t.id !== id);
    if (remaining.length === 0) {
      onClose();
      return;
    }
    if (id === activeIdRef.current) {
      const idx = tabsRef.current.findIndex((t) => t.id === id);
      const next = remaining[Math.min(idx, remaining.length - 1)];
      setActiveId(next.id);
    }
    // If the tab whose conversation is showing is gone, re-anchor the discussion
    // to the (new) active tab so the chat pane never points at a dead thread.
    if (id === discussionIdRef.current) {
      const stillThere = remaining.some((t) => t.id === discussionIdRef.current);
      if (!stillThere) {
        const idx = tabsRef.current.findIndex((t) => t.id === id);
        const next = remaining[Math.min(idx, remaining.length - 1)];
        setDiscussionId(
          id === activeIdRef.current ? next.id : activeIdRef.current,
        );
      }
    }
    setTabs(remaining);
  };

  // --- Mission tab-workspace swap -----------------------------------------
  // Each mission owns a tab set; "regular browsing" is its own bucket
  // (`TABS_KEY`). Switching swaps the whole workspace. Discussions reattach for
  // free because a tab is rebuilt with its durable `browseId` (BrowserChat keys
  // on it and loads the thread from the DB).

  const descriptorOf = (t: Tab) => ({
    id: t.id,
    url: t.url,
    title: t.title,
    browseId: t.browseId,
  });

  // Rebuild Tab[] from saved descriptors: fresh `t<n>` ids (so no collision with
  // any live tab) but the SAME `browseId` (so each discussion reattaches).
  const rebuildTabs = (
    descs: { url: string; title?: string; browseId?: string | null }[],
  ): Tab[] => {
    const built = descs
      .filter((d) => d && typeof d.url === "string" && d.url.length > 0)
      .map((d) => {
        const id = `t${seqRef.current++}`;
        return {
          id,
          label: `browser-${id}`,
          url: d.url,
          title: d.title || hostnameOf(d.url),
          browseId: d.browseId || newBrowseId(),
        } as Tab;
      });
    return built.length ? built : [freshHomeTab()];
  };

  // Flush the current tabs to their bucket (mission row or `TABS_KEY`). Callers
  // run this before leaving a workspace so nothing is lost on switch.
  const saveCurrentWorkspace = async () => {
    const descs = tabsRef.current.map(descriptorOf);
    const mid = activeMissionIdRef.current;
    if (mid) {
      await mission.setMissionTabs(mid, descs);
    } else {
      try {
        localStorage.setItem(TABS_KEY, JSON.stringify(descs));
      } catch {
        /* ignore */
      }
    }
  };

  // Tear down every live native webview (the swap rebuilds with new ids).
  const teardownLiveWebviews = () => {
    for (const [id] of [...wvMapRef.current]) closeWebview(`browser-${id}`);
    wvMapRef.current.clear();
    creatingRef.current.clear();
  };

  // PURE load (callers save the outgoing workspace first): tear down the current
  // webviews, materialize the target's tabs, and flip the active mission.
  const swapWorkspace = async (
    target: { kind: "mission"; id: string } | { kind: "regular" },
  ) => {
    swappingRef.current = true;
    if (missionTabsTimerRef.current) {
      window.clearTimeout(missionTabsTimerRef.current);
      missionTabsTimerRef.current = null;
    }
    teardownLiveWebviews();
    const newSet =
      target.kind === "mission"
        ? rebuildTabs(await mission.getMissionTabs(target.id))
        : loadTabs();
    const active = newSet[0];
    // Seed only the active tab live (mirror mount seeding); others lazy-wake.
    liveIntentRef.current = new Set([active.id]);
    mruRef.current = [active.id];
    lastRectRef.current = null;
    setTabs(newSet);
    setActiveId(active.id);
    setDiscussionId(active.id);
    setAddr(active.url);
    setLiveVersion((v) => v + 1);
    if (target.kind === "mission") mission.resumeMission(target.id);
    else mission.closeMission();
    swappingRef.current = false;
  };

  // Start a new mission. From regular browsing the current tabs carry in (and
  // regular resets to a clean slate); from inside a mission, that one is saved
  // and the new one opens fresh.
  const startNewMission = async (title: string, goal: string) => {
    const fromRegular = !activeMissionIdRef.current;
    const currentDescs = tabsRef.current.map(descriptorOf);
    await saveCurrentWorkspace();
    const m = await mission.startMission(title, goal); // sets active = m
    if (!m) return;
    if (fromRegular) {
      await mission.setMissionTabs(m.missionId, currentDescs);
      try {
        localStorage.setItem(
          TABS_KEY,
          JSON.stringify([descriptorOf(freshHomeTab())]),
        );
      } catch {
        /* ignore */
      }
      // No swap — the current tabs/webviews stay; they're now the mission's.
    } else {
      await swapWorkspace({ kind: "mission", id: m.missionId });
    }
    setChatOpen(true);
    setChatTab("mission");
  };

  const switchToMission = async (id: string) => {
    if (id === activeMissionIdRef.current) {
      setChatOpen(true);
      setChatTab("mission");
      return;
    }
    await saveCurrentWorkspace();
    await swapWorkspace({ kind: "mission", id });
    setChatOpen(true);
    setChatTab("mission");
  };

  const exitMission = async () => {
    await saveCurrentWorkspace();
    await swapWorkspace({ kind: "regular" });
  };

  const deleteMissionFlow = async (id: string) => {
    // Leave the mission first (without saving — its tabs are being discarded).
    if (id === activeMissionIdRef.current) await swapWorkspace({ kind: "regular" });
    await mission.deleteMission(id);
  };

  // On mount, if a mission was active last session, reopen its tab workspace
  // (once the mission list resolves). User-initiated activations happen after
  // this runs, so they don't double-swap.
  useEffect(() => {
    if (initDoneRef.current) return;
    const pendingId = mission.activeMissionId;
    if (!pendingId) {
      initDoneRef.current = true;
      return;
    }
    if (mission.activeMission) {
      initDoneRef.current = true;
      void swapWorkspace({ kind: "mission", id: pendingId });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mission.activeMissionId, mission.activeMission]);

  // Cmd+W (native File ▸ Close Tab) closes the active tab. A menu accelerator
  // fires even while the native webview has focus — which a JS keydown listener
  // can't catch — so the keystroke is delivered as this event instead. Kept in
  // a ref so the once-subscribed listener always calls the latest closeTab
  // (which closes the pane via onClose when the last tab goes).
  const closeActiveRef = useRef<() => void>(() => {});
  closeActiveRef.current = () => closeTab(activeIdRef.current);
  useEffect(() => {
    const p = listen("menu-close-tab", () => closeActiveRef.current());
    return () => {
      void p.then((un) => un());
    };
  }, []);

  const navigate = (raw: string, id: string = activeIdRef.current) => {
    // Omnibox: a URL-like entry navigates; anything else becomes a web search.
    const url = resolveOmniboxInput(raw);
    if (!url) return;
    setTabs((ts) =>
      ts.map((t) =>
        t.id === id ? { ...t, url, title: hostnameOf(url) } : t,
      ),
    );
    if (id === activeIdRef.current) setAddr(url);
    // No live webview for this tab (suspended, or a prior creation failed)?
    // Recreate it — the fresh webview loads `url` (just written into the tab),
    // so Go/refresh heals a blank, webview-less tab instead of being a silent
    // no-op (`browser_navigate` would just error on the missing label).
    if (!wvMapRef.current.has(id)) {
      ensureLive(id);
      return;
    }
    void invoke("browser_navigate", { label: `browser-${id}`, url }).catch(
      (e) => {
        console.error("browser_navigate failed", e);
        // The webview vanished under us (e.g. its process was reclaimed and the
        // handle is stale) — drop the dead handle and recreate at `url`.
        wvMapRef.current.delete(id);
        ensureLive(id);
      },
    );
  };

  const evalActive = (script: string) => {
    void invoke("browser_eval", {
      label: `browser-${activeIdRef.current}`,
      script,
    }).catch((e) => console.error("browser_eval failed", e));
  };

  const saveBookmarkFor = (url: string, name: string) => {
    if (!url) return;
    const title = name.trim() || hostnameOf(url);
    setBookmarks((bs) =>
      bs.some((b) => b.url === url)
        ? bs.map((b) => (b.url === url ? { ...b, title } : b))
        : [...bs, { title, url }],
    );
  };

  const removeBookmark = (url: string) =>
    setBookmarks((bs) => bs.filter((b) => b.url !== url));

  // Native text prompt for naming (a native menu can't host an input).
  const promptName = (message: string, def: string): Promise<string | null> =>
    invoke<string | null>("prompt_text", { message, defaultValue: def }).catch(
      () => null,
    );

  // Open the native bookmarks popup menu (floats over the webview). The menu
  // is positioned at the ★ button (window coords) because the async command
  // has no active NSEvent to anchor to. muda pins the menu's top-LEFT at this
  // point and grows it right/down, and the ★ sits near the window's right edge,
  // so clamp X to keep the menu fully on-screen instead of spilling off-right.
  const MENU_WIDTH = 300;
  const openBookmarksMenu = (e: React.MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const margin = 8;
    const maxX = window.innerWidth - MENU_WIDTH - margin;
    const x = Math.max(margin, Math.min(r.left, maxX));
    void invoke("show_bookmarks_menu", {
      titles: bookmarksRef.current.map((b) => b.title || b.url),
      currentBookmarked: bookmarksRef.current.some(
        (b) => b.url === activeUrlRef.current,
      ),
      hasCurrent: !!activeUrlRef.current,
      x: Math.round(x),
      y: Math.round(r.bottom + 4),
    }).catch((err) => console.error("show_bookmarks_menu failed", err));
  };

  // Act on a click from the native bookmarks menu. Reads refs so the listener
  // never goes stale.
  const handleBmAction = async (id: string) => {
    if (id === "bm-add") {
      const url = activeUrlRef.current;
      const name = await promptName("Bookmark name:", hostnameOf(url));
      if (name !== null) saveBookmarkFor(url, name);
      return;
    }
    if (id === "bm-remove-current") {
      removeBookmark(activeUrlRef.current);
      return;
    }
    const m = id.match(/^bm-(open|newtab|rename|remove)-(\d+)$/);
    if (!m) return;
    const action = m[1];
    const b = bookmarksRef.current[Number(m[2])];
    if (!b) return;
    if (action === "open") navigate(b.url);
    else if (action === "newtab") openTab(b.url);
    else if (action === "remove") removeBookmark(b.url);
    else if (action === "rename") {
      const name = await promptName("Rename bookmark:", b.title);
      if (name !== null && name.trim()) saveBookmarkFor(b.url, name);
    }
  };

  // The browse agent opens a tab by emitting `browse-open-tab` (it can't create
  // a native webview itself — BrowserPane owns the tab list). Foreground the new
  // tab but keep the discussion anchored to the conversation that opened it.
  // openTab is read through a ref so this listener subscribes once.
  const openTabRef = useRef(openTab);
  openTabRef.current = openTab;
  useEffect(() => {
    const p = listen<BrowseOpenTabEvent>("browse-open-tab", (e) => {
      const url = e.payload?.url;
      if (url) openTabRef.current(url, { anchorDiscussion: true });
    });
    return () => {
      void p.then((un) => un());
    };
  }, []);

  // The browse agent switches the user into an existing tab by emitting
  // `browse-focus-tab`. selectTab foregrounds it AND moves the discussion into
  // its thread — a full switch, exactly like clicking the tab.
  const selectTabRef = useRef(selectTab);
  selectTabRef.current = selectTab;
  useEffect(() => {
    const p = listen<BrowseFocusTabEvent>("browse-focus-tab", (e) => {
      const id = e.payload?.id;
      if (id && tabsRef.current.some((t) => t.id === id)) {
        selectTabRef.current(id);
      }
    });
    return () => {
      void p.then((un) => un());
    };
  }, []);

  // The daemon needs a suspended tab live to run a query/action. Unlike focus,
  // this is a BACKGROUND wake: mark it live so reconcile recreates the webview
  // (hidden, since it's not the active tab) — no foregrounding, no discussion-
  // pane move. It stays at the back of the recency order, so it's the first
  // re-suspended on the next budget pass.
  const ensureLiveRef = useRef(ensureLive);
  ensureLiveRef.current = ensureLive;
  useEffect(() => {
    const p = listen<BrowseWakeTabEvent>("browse-wake-tab", (e) => {
      const id = e.payload?.id;
      if (id && tabsRef.current.some((t) => t.id === id)) {
        ensureLiveRef.current(id);
      }
    });
    return () => {
      void p.then((un) => un());
    };
  }, []);

  // Subscribe once to native-menu clicks.
  useEffect(() => {
    const p = listen<string>("bookmark-menu-action", (e) => {
      void handleBmAction(e.payload);
    });
    return () => {
      void p.then((un) => un());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-apply the chosen view filter to every live tab whenever it changes.
  // The native command installs it as a document-start user script (no flash on
  // later navigations) and also injects into the now-loaded page so it's instant.
  useEffect(() => {
    const css = cssForView(viewMode);
    for (const t of tabsRef.current) {
      if (wvMapRef.current.has(t.id)) {
        void invoke("browser_set_view", { label: t.label, css }).catch((e) =>
          console.error("browser_set_view failed", e),
        );
      }
    }
  }, [viewMode]);

  // A click in the native View menu arrives here (HTML can't overlay the
  // webview, so the picker is a native popup like bookmarks). "view-none" resets.
  useEffect(() => {
    const p = listen<string>("view-menu-action", (e) => {
      const mode = e.payload === "view-none" ? "none" : e.payload.replace("view-", "");
      setViewMode(mode in VIEW_CSS ? mode : "none");
    });
    return () => {
      void p.then((un) => un());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Open the native View-filter popup, dropping straight down from the 🎨
  // button. muda pins the menu's top-LEFT at (x,y) and grows right/down; the
  // button sits near the window's right edge, so RIGHT-align the menu to the
  // button (left = buttonRight − menuWidth) instead of left-anchoring it (which
  // left a big gap). VIEW_MENU_WIDTH is the menu's approx native width. Clamp
  // so it never spills off either edge.
  const VIEW_MENU_WIDTH = 160;
  const openViewMenu = (e: React.MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const margin = 8;
    const maxX = window.innerWidth - VIEW_MENU_WIDTH - margin;
    const x = Math.max(margin, Math.min(r.right - VIEW_MENU_WIDTH, maxX));
    void invoke("show_view_menu", {
      active: viewMode,
      x: Math.round(x),
      y: Math.round(r.bottom + 4),
    }).catch((err) => console.error("show_view_menu failed", err));
  };

  const chromeBtn: React.CSSProperties = {
    fontSize: "13px",
    lineHeight: 1,
    padding: "3px 7px",
    border: "1px solid var(--color-rule)",
    background: "var(--color-bg-elevated)",
    color: "var(--color-ink)",
    borderRadius: "4px",
    cursor: "pointer",
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Tab strip + toolbar — hidden while a page is in-window fullscreen so
          the video fills the whole Redline window. */}
      {!browserFullscreen && (
        <>
      {/* Tab strip — scrolls horizontally when the pane is too narrow to show
          every tab (each tab keeps its width instead of being squeezed away). */}
      <div
        className="flex items-center gap-1 px-2 pt-2 overflow-x-auto"
        style={{ background: "var(--color-bg-elevated)" }}
      >
        {tabs.map((tab, i) => {
          const active = tab.id === activeId;
          return (
            <div
              key={tab.id}
              onClick={() => selectTab(tab.id)}
              title={tab.url}
              className={`flex items-center gap-1.5 rounded-t-md cursor-pointer${
                mission.activeMission
                  ? mission.pinnedBrowseIds.has(tab.browseId)
                    ? " rl-tab--mission rl-tab--mined"
                    : " rl-tab--mission"
                  : ""
              }`}
              style={{
                maxWidth: "180px",
                flexShrink: 0,
                padding: "5px 8px",
                fontSize: "12px",
                borderTop: "1px solid var(--color-rule)",
                borderLeft: "1px solid var(--color-rule)",
                borderRight: "1px solid var(--color-rule)",
                background: active
                  ? "var(--color-paper)"
                  : "var(--color-bg-elevated)",
                color: active ? "var(--color-ink)" : "var(--color-ink-muted)",
              }}
            >
              {/* 1-based tab number — the user's (and the agent's) handle for the
                  tab ("tab 2"), and the only way to tell two same-host tabs apart.
                  Positional/display-only; nothing durable keys on it. */}
              <span
                aria-hidden
                style={{
                  flexShrink: 0,
                  minWidth: "13px",
                  textAlign: "center",
                  fontSize: "10px",
                  fontVariantNumeric: "tabular-nums",
                  lineHeight: "15px",
                  borderRadius: "4px",
                  border: "1px solid var(--color-rule)",
                  background: active
                    ? "var(--color-bg-elevated)"
                    : "transparent",
                  color: "var(--color-ink-muted)",
                }}
              >
                {i + 1}
              </span>
              <span className="truncate">{tab.title || "New tab"}</span>
              <button
                type="button"
                aria-label="Close tab"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(tab.id);
                }}
                style={{
                  fontSize: "11px",
                  lineHeight: 1,
                  color: "var(--color-ink-muted)",
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                  flexShrink: 0,
                }}
              >
                ✕
              </button>
            </div>
          );
        })}
        <button
          type="button"
          title="New tab"
          aria-label="New tab"
          onClick={() => openTab()}
          disabled={tabs.length >= MAX_TABS}
          style={{
            ...chromeBtn,
            border: "none",
            background: "transparent",
            fontSize: "16px",
            flexShrink: 0,
            opacity: tabs.length >= MAX_TABS ? 0.4 : 1,
            cursor: tabs.length >= MAX_TABS ? "default" : "pointer",
          }}
        >
          +
        </button>
      </div>

      {/* Toolbar */}
      <div
        className="flex items-center gap-2 px-3 py-2"
        style={{
          borderTop: "1px solid var(--color-rule)",
          borderBottom: "1px solid var(--color-rule)",
          background: "var(--color-bg-elevated)",
        }}
      >
        <button
          type="button"
          style={chromeBtn}
          title="Back"
          aria-label="Back"
          onClick={() => evalActive("history.back()")}
        >
          ◀
        </button>
        <button
          type="button"
          style={chromeBtn}
          title="Forward"
          aria-label="Forward"
          onClick={() => evalActive("history.forward()")}
        >
          ▶
        </button>
        <form
          className="flex-1 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            navigate(addr);
          }}
        >
          <input
            value={addr}
            onChange={(e) => setAddr(e.target.value)}
            onFocus={(e) => {
              addrFocusedRef.current = true;
              e.target.select();
            }}
            onBlur={() => {
              addrFocusedRef.current = false;
            }}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            placeholder="Enter a URL"
            className="flex-1 rounded-sm px-2 py-1 font-mono"
            style={{
              fontSize: "12px",
              border: "1px solid var(--color-rule)",
              background: "var(--color-paper)",
              color: "var(--color-ink)",
            }}
          />
          <button type="submit" style={chromeBtn} title="Go">
            Go
          </button>
        </form>
        <button
          type="button"
          style={{
            ...chromeBtn,
            color: isBookmarked ? "var(--color-info)" : "var(--color-ink)",
          }}
          title="Bookmarks"
          aria-label="Bookmarks"
          aria-haspopup="menu"
          onClick={openBookmarksMenu}
        >
          {isBookmarked ? "★" : "☆"}
        </button>
        <button
          type="button"
          style={{
            ...chromeBtn,
            color: viewMode !== "none" ? "var(--color-info)" : "var(--color-ink)",
          }}
          title="View filter (dark mode, sepia, …)"
          aria-label="View filter"
          aria-haspopup="menu"
          onClick={openViewMenu}
        >
          🎨
        </button>
        {/* 🎯 and the missions ▾ menu read as ONE control: a single bordered
            chip with two borderless segments split by a hairline, so there's no
            gap or double-border between them. The chip tints to the accent when
            a mission is active; the pin count rides the top-right corner. */}
        <div
          className="relative flex items-stretch"
          style={{
            border: `1px solid ${
              mission.activeMission ? "var(--color-info)" : "var(--color-rule)"
            }`,
            borderRadius: "4px",
            background: "var(--color-bg-elevated)",
          }}
        >
          <button
            type="button"
            style={{
              border: "none",
              background: "transparent",
              cursor: "pointer",
              fontSize: "13px",
              lineHeight: 1,
              padding: "3px 6px",
              // Fully rounded when it's the lone segment; left-rounded when the
              // ▾ menu sits beside it.
              borderRadius: missionShowMenu ? "3px 0 0 3px" : "3px",
              color: mission.activeMission ? "var(--color-info)" : "var(--color-ink)",
              opacity: mission.activeMission ? 1 : 0.85,
            }}
            title={
              mission.activeMission
                ? `Mission: ${mission.activeMission.title}`
                : "Start a research mission across your tabs"
            }
            aria-label="Mission"
            onClick={() => {
              if (mission.activeMission) {
                setChatOpen(true);
                setChatTab("mission");
              } else {
                setMissionDialogOpen(true);
              }
            }}
          >
            🎯
          </button>
          {/* The ▾ missions menu (switch / resume / archive / start another)
              only earns its place once a mission exists to manage; with none,
              the bare 🎯 is "start a mission" and the caret would be dead. */}
          {missionShowMenu && (
            <>
              <span aria-hidden style={{ width: "1px", background: "var(--color-rule)", margin: "3px 0" }} />
              <button
                type="button"
                style={{
                  border: "none",
                  background: "transparent",
                  cursor: "pointer",
                  fontSize: "8px",
                  lineHeight: 1,
                  padding: "0 5px",
                  borderRadius: "0 3px 3px 0",
                  color: mission.activeMission ? "var(--color-info)" : "var(--color-ink-muted)",
                }}
                title="Missions: start, switch, resume"
                aria-label="Missions menu"
                aria-haspopup="menu"
                onClick={() => setMissionMenuOpen((x) => !x)}
              >
                ▾
              </button>
            </>
          )}
          {mission.activeMission && mission.findings.length > 0 && (
            <span
              aria-hidden
              style={{
                position: "absolute",
                top: "-6px",
                right: "-6px",
                minWidth: "14px",
                height: "14px",
                padding: "0 3px",
                borderRadius: "7px",
                background: "var(--color-info)",
                color: "var(--color-on-accent)",
                fontSize: "9px",
                lineHeight: "14px",
                textAlign: "center",
                fontVariantNumeric: "tabular-nums",
                pointerEvents: "none",
              }}
            >
              {mission.findings.length}
            </span>
          )}
          {missionMenuOpen && (
            <MissionMenu
              missions={mission.missions}
              activeId={mission.activeMission?.missionId ?? null}
              onStartNew={() => {
                setMissionMenuOpen(false);
                setMissionDialogOpen(true);
              }}
              onResume={(id) => {
                setMissionMenuOpen(false);
                void switchToMission(id);
              }}
              onExit={() => {
                setMissionMenuOpen(false);
                void exitMission();
              }}
              onDelete={(id) => {
                void deleteMissionFlow(id);
              }}
              onClose={() => setMissionMenuOpen(false)}
            />
          )}
        </div>
        <button
          type="button"
          style={{
            ...chromeBtn,
            color: chatOpen && chatTab === "page" ? "var(--color-info)" : "var(--color-ink)",
          }}
          title="Discuss this page with Claude (reads & drives the browser)"
          aria-label="Discuss this page"
          aria-pressed={chatOpen && chatTab === "page"}
          onClick={() => {
            if (chatOpen && chatTab === "page") {
              setChatOpen(false);
            } else {
              setChatOpen(true);
              setChatTab("page");
            }
          }}
        >
          💬
        </button>
        <button
          type="button"
          style={chromeBtn}
          title="Close browser"
          aria-label="Close browser"
          onClick={onClose}
        >
          ✕
        </button>
      </div>
        </>
      )}

      {/* The active tab's native webview is positioned to cover this slot. When
          the page-discussion panel is open, a SplitPane shrinks the slot so the
          webview shares the pane with the chat (the webview tracks the slot's
          rect, so it resizes automatically). */}
      {(() => {
        const slot = (
          <div
            ref={slotRef}
            className={browserFullscreen ? "relative" : "flex-1 relative"}
            style={
              browserFullscreen
                ? {
                    // Above App's z-30 overlays so the video covers the window.
                    background: "var(--color-paper)",
                    position: "fixed",
                    inset: 0,
                    zIndex: 50,
                  }
                : { background: "var(--color-paper)" }
            }
          />
        );
        // Fullscreen takes over the whole pane — no chat split, just the slot.
        if (browserFullscreen || !chatOpen) return slot;
        const activeTab = tabs.find((t) => t.id === activeId) ?? tabs[0];
        // The chat shows the DISCUSSION tab's thread (usually the active tab, but
        // pinned to its origin when an agent opened the active tab). It still
        // grounds on the visible page via `label`.
        const discussionTab =
          tabs.find((t) => t.id === discussionId) ?? activeTab;
        const chatPanel = (
          <div className="flex flex-col h-full min-h-0">
            <DiscussionSwitcher
              tab={chatTab}
              setTab={setChatTab}
              hasMission={!!mission.activeMission}
              pinCount={mission.findings.length}
            />
            <div className="flex-1 min-h-0">
              {chatTab === "mission" ? (
                mission.activeMission ? (
                  <MissionChat
                    key={mission.activeMission.missionId}
                    mission={mission.activeMission}
                    findings={mission.findings}
                    projectDir={projectDir}
                    onClose={() => setChatOpen(false)}
                    onOpenLink={(url) => openTab(url)}
                    onRemoveFinding={(id) => void mission.removeFinding(id)}
                    onJumpToFinding={(bid) => {
                      const t = tabsRef.current.find((x) => x.browseId === bid);
                      if (t) {
                        selectTab(t.id);
                        setChatTab("page");
                      }
                    }}
                    onEditGoal={(title, goal) =>
                      mission.activeMission &&
                      void mission.setGoal(mission.activeMission.missionId, title, goal)
                    }
                    onSynthesize={onSynthesizeToDrafter}
                  />
                ) : (
                  <MissionEmptyState onStart={() => setMissionDialogOpen(true)} />
                )
              ) : (
                <BrowserChat
                  key={discussionTab.browseId}
                  browseId={discussionTab.browseId}
                  label={`browser-${activeId}`}
                  projectDir={projectDir}
                  anchoredFromTitle={
                    discussionTab.id !== activeId ? discussionTab.title : undefined
                  }
                  onClose={() => setChatOpen(false)}
                  onOpenLink={(url) => openTab(url)}
                  onSendToRedline={onSendToRedline}
                  onAddToMission={
                    mission.activeMission
                      ? (body) =>
                          void mission.addFinding({
                            body,
                            browseId: discussionTab.browseId,
                            sourceUrl: discussionTab.url,
                            sourceTitle: discussionTab.title,
                          })
                      : undefined
                  }
                />
              )}
            </div>
          </div>
        );
        return (
          <SplitPane
            vertical={false}
            ratio={chatRatio}
            onRatioChange={setChatRatio}
            onDraggingChange={setChatDragging}
            first={slot}
            second={chatPanel}
          />
        );
      })()}

      {missionDialogOpen && (
        <MissionStartDialog
          onCancel={() => setMissionDialogOpen(false)}
          onStart={(title, goal) => {
            setMissionDialogOpen(false);
            void startNewMission(title, goal);
          }}
        />
      )}
    </div>
  );
}

/** The slim two-tab switcher atop the discussion split: per-tab page chat vs the
 *  mission orchestrator (a tier above). */
function DiscussionSwitcher({
  tab,
  setTab,
  hasMission,
  pinCount,
}: {
  tab: "page" | "mission";
  setTab: (t: "page" | "mission") => void;
  hasMission: boolean;
  pinCount: number;
}) {
  const pill = (active: boolean): React.CSSProperties => ({
    fontSize: "10px",
    fontWeight: 600,
    padding: "2px 8px",
    borderRadius: "5px",
    border: "1px solid var(--color-rule)",
    background: active ? "var(--color-info)" : "var(--color-paper)",
    color: active ? "var(--color-on-accent)" : "var(--color-ink-muted)",
    cursor: "pointer",
    whiteSpace: "nowrap",
  });
  return (
    <div
      className="flex items-center gap-1.5 px-3 py-1.5 shrink-0"
      style={{ borderBottom: "1px solid var(--color-rule)", background: "var(--color-bg-elevated)" }}
    >
      <button type="button" style={pill(tab === "page")} onClick={() => setTab("page")}>
        💬 This page
      </button>
      <button type="button" style={pill(tab === "mission")} onClick={() => setTab("mission")}>
        🎯 Mission{hasMission && pinCount > 0 ? ` · ${pinCount}` : ""}
      </button>
    </div>
  );
}

/** Shown in the Mission tab when no mission is active yet. */
function MissionEmptyState({ onStart }: { onStart: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-3 px-6 text-center">
      <span style={{ fontSize: "28px" }}>🎯</span>
      <p style={{ fontSize: "12px", color: "var(--color-ink-muted)", lineHeight: 1.5 }}>
        A mission gives your browsing one goal. An orchestrator watches every tab,
        gathers what you pin, and helps you synthesize it toward that goal.
      </p>
      <button
        type="button"
        onClick={onStart}
        className="rounded px-3 py-1.5 font-medium"
        style={{ fontSize: "12px", background: "var(--color-info)", color: "var(--color-on-accent)" }}
      >
        Start a mission 🎯
      </button>
    </div>
  );
}

/** Start / switch / resume dropdown hung off the toolbar 🎯. Rendered as React
 *  DOM with the native webview hidden (the pane drops `visible` while it's open),
 *  same reason bookmarks use a native popup. */
function MissionMenu({
  missions,
  activeId,
  onStartNew,
  onResume,
  onExit,
  onDelete,
  onClose,
}: {
  missions: Mission[];
  activeId: string | null;
  onStartNew: () => void;
  onResume: (id: string) => void;
  onExit: () => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <>
      {/* click-away backdrop */}
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        className="absolute z-50 rounded-md py-1"
        style={{
          top: "calc(100% + 4px)",
          right: 0,
          width: "17rem",
          maxHeight: "60vh",
          overflowY: "auto",
          background: "var(--color-paper)",
          border: "1px solid var(--color-rule)",
          boxShadow: "0 8px 28px rgba(0,0,0,0.25)",
        }}
      >
        <button
          type="button"
          onClick={onStartNew}
          className="w-full text-left px-3 py-1.5"
          style={{ fontSize: "12px", color: "var(--color-info)", fontWeight: 600 }}
        >
          + Start new mission
        </button>
        {activeId && (
          <button
            type="button"
            onClick={() => {
              onClose();
              onExit();
            }}
            className="w-full text-left px-3 py-1.5"
            style={{ fontSize: "12px", color: "var(--color-ink)" }}
          >
            ← Exit to regular browsing
          </button>
        )}
        {missions.length > 0 && <div style={{ borderTop: "1px solid var(--color-rule)" }} />}
        {missions.map((m) => (
          <div
            key={m.missionId}
            className="flex items-center gap-1 px-3 py-1.5 group/m"
            style={{ background: m.missionId === activeId ? "var(--color-bg-elevated)" : "transparent" }}
          >
            <button
              type="button"
              onClick={() => onResume(m.missionId)}
              className="flex-1 min-w-0 text-left"
              title={m.goal}
            >
              <div className="truncate" style={{ fontSize: "12px", color: "var(--color-ink)" }}>
                {m.missionId === activeId ? "● " : ""}
                {m.title}
              </div>
              <div className="truncate" style={{ fontSize: "9.5px", color: "var(--color-ink-muted)" }}>
                {m.missionId === activeId ? "active" : "tap to resume"}
              </div>
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                if (
                  window.confirm(
                    `Delete mission “${m.title}”? This removes its pins, chat, and saved tabs. This can't be undone.`,
                  )
                ) {
                  onDelete(m.missionId);
                }
              }}
              title="Delete this mission"
              className="opacity-0 group-hover/m:opacity-100"
              style={{ fontSize: "11px", color: "var(--color-warning)" }}
            >
              Delete
            </button>
          </div>
        ))}
      </div>
    </>
  );
}
