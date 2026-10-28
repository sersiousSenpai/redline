import { loadBrowserWorkspace, saveBrowserWorkspace, noteWorkspaceRevision, type SavedBrowserWorkspace } from "../lib/browserWorkspace";
import { BrowserAppearanceMenu } from "./BrowserAppearanceMenu";
import { appearanceCss, normalizeAppearance, siteKey, type BrowserAppearance } from "../lib/browserAppearance";
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { lazy, memo, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal, flushSync } from "react-dom";

import { shortcutTabId } from "../lib/browseChatState";
import { dockDescriptor, resolveConversation, type ChatEvent } from "../lib/browserChat/scope";
import { seedPolicy, type SeedSource } from "../lib/browserChat/turn";
import { useChatWorld } from "../hooks/useChatWorld";
import { useStableHandlers, useStableValue } from "../hooks/useStable";
import { ensureCart } from "../lib/browseCart";
import { createNativeBrowserGeometry, fullWindowRect, measureNativeBrowserRect } from "../lib/nativeBrowserGeometry";
import { useVideoFullscreen } from "../hooks/useVideoFullscreen";
import { usePoll } from "../hooks/usePoll";
import { BrowserFullscreenEdge } from "./BrowserFullscreenEdge";
import { fallbackGroups, reconcileGroups, validateGroups, moveTabToGroup, type TabGroup } from "../lib/tabGroups";
import { BrowserChrome } from "./BrowserChrome";
import { BrowserLayoutDialog, BrowserBookmarksDialog, BrowserPreferencesDialog } from "./BrowserPagePanels";
import { BrowserDialog } from "./BrowserSurfaces";
import "./BrowserWorkspace.css";
import { BrowserTileStage } from "./BrowserTileStage";
import { arrangementTiles, swapVisibleTiles, tileBadges, assignTile, canonicalTabId, restoreBrowserTabs, focusedWorkspaceTab, assignVisibleTile, DEFAULT_BROWSER_LAYOUT, MAX_MOSAIC_TILES, normalizeBrowserLayout, visibleGrid, visibleTileIds, type BrowserLayout } from "../lib/browserLayout";
import { deleteMosaic, gridFor, isMosaicWorkspace, listMosaics, loadMosaic, mosaicFromWorkspace, mosaicLayout, mosaicTabs, mosaicWorkspaceId, saveMosaic, STARTUP_MOSAIC_KEY, type Mosaic, type MosaicSummary } from "../lib/browserMosaics";
import { MosaicEditDialog, MosaicManagerDialog, type MosaicDraft } from "./MosaicDialogs";
import { useElementPicker, inspectorSeed, PICKING_ERROR } from "../hooks/useElementPicker";
import { reorderTabs, startTabPointerDrag } from "../lib/browserTabDrag";
import { Target, X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Window } from "@tauri-apps/api/window";
import { Webview } from "@tauri-apps/api/webview";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { usePersistedState } from "../theme/usePersistedState";
import { resolveOmniboxInput } from "../lib/omnibox";
import { BROWSER_HOME_URL as HOME, NEWTAB, browserPageTitle, initialBrowserTitle } from "../lib/browserTitle";
import {
  chatEntryFor,
  pruneChatState,
  withChatPatch,
  type BrowserDockState,
  type ChatPill,
  type ChatStateMap,
} from "../lib/browseChatState";
import { cartKey, sameTabUrl } from "../lib/browseList";
import {
  parseSelectionEvents,
  promptForSelection,
  type SelectionEvent,
} from "../lib/browseSelection";
import {
  fallbackLocator,
  parsePageContext,
  type PageContext,
  type RawLocator,
} from "../lib/pageLocator";
import { SAFARI_UA } from "../lib/safariUA";
import { isDurableTabUrl } from "../lib/browserOutput";
// `BrowserPane` is a static import in App, so it sits in the boot path. The
// list panel only exists once a user picks the pill, so it has no business
// costing boot bytes — and `scripts/size-budget.json` has limited headroom.
const MissionFoundationPanel = lazy(() => import("./MissionFoundationPanel").then((module) => ({ default: module.MissionFoundationPanel })));
const BrowserTabRail = lazy(() => import("./BrowserTabRail"));
const BrowserHomePage = lazy(() => import("./BrowserHomePage"));
const Cart = lazy(() => import("./Cart"));
import type {
  BinaryFile,
  BrowseFocusTabEvent,
  BrowseOpenTabEvent,
  BrowseWakeTabEvent,
  Mission,
} from "../types";
import { onResizeSession } from "../lib/resizeSession";
import { BrowserChat } from "./BrowserChat";
import { MissionChat } from "./MissionChat";
import { MissionStartDialog } from "./MissionStartDialog";
import { useMission } from "../hooks/useMission";
import { usePageActions } from "../hooks/usePageActions";

// A native child webview is an OS-level layer painted on top of the React DOM —
// it does not flow inline. So this component renders an invisible placeholder
// ("slot") for each visible page and syncs native bounds to its clipped rect.
// Each tab is its own native child webview (label `browser-<id>`),
// with only the pages in the current arrangement shown. Unlike an <iframe>, a real child webview loads
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
// Not a UX limit — like Safari/Chrome there's no real cap on how many tabs you
// keep, because idle tabs are SUSPENDED (only `MAX_LIVE_WEBVIEWS` are ever live
// at once), so memory is bounded by live webviews, not by strip length. This
// high ceiling exists ONLY as a runaway guard: the new-tab interceptor opens a
// tab per `window.open`/`target=_blank`, so a buggy or hostile page could spam
// them — the same thing browsers' popup blockers defend against.
const MAX_TABS = 100;
// Floor on simultaneously-live native webviews (active + MRU). Every visible
// tile is kept live on top of it — a mosaic raises the budget to its tile
// count, up to MAX_MOSAIC_TILES. The rest are suspended to the snapshot cache.
const MAX_LIVE_WEBVIEWS = 4;
// Native webview creations in flight at once. Opening a 3×3 mosaic would
// otherwise spawn nine WebContent processes in one frame.
const MAX_CONCURRENT_CREATES = 3;
// The startup mosaic opens on the browser's FIRST mount in an app session.
// Module scope, because the lazy pane can remount.
let startupMosaicApplied = false;
// (The page-discussion split — and the ratio clamp that kept its chat side off
// zero width — is gone: the four panels moved into the app's conversation
// dock, whose own ceiling is `voicePaneMaxW`. The webview now has the whole
// pane, and the dock shrinks the plate around it rather than the pane.)
// The embedded WKWebView's default user-agent omits the "Safari" token, so
// sites (Google included) serve a legacy/basic layout. Presenting a current
// Safari UA makes them serve the modern experience the engine can render.
// Exported because the Localhost dashboard's thumbnail webview must present the
// SAME identity as a real tab — a dev server's landing page served a legacy
// layout would be captured as one, and the screenshot would not match what the
// user sees when they click Open.
export { SAFARI_UA };

/** Browser pages have a square, edge-to-edge frame. */
export const WEBVIEW_PLATE_INSET = 0;
export const webviewSlotInset = (_fullscreen: boolean): number => 0;

/** The tab pictures worth keeping: one per open tab. Each is a PNG data URL
 *  as wide as its tile, and a closed tab's (or a swapped-out workspace's) is
 *  never shown again, so keeping every one ever taken grew without bound
 *  (docs/perf-budget.md rule 7). The same map back when none went. */
export function shotsForOpenTabs(
  shots: Map<string, string>,
  tabs: readonly { id: string }[],
): Map<string, string> {
  const open = new Set(tabs.map((t) => t.id));
  if ([...shots.keys()].every((id) => open.has(id))) return shots;
  return new Map([...shots].filter(([id]) => open.has(id)));
}

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
  /** Page title, or a stable initial label while the page loads. */
  title: string;
  favicon?: string;
  /** Stable id for this tab's browse-agent discussion thread. Survives reload
   *  (persisted with the tab list) and the recreated native webview, so a tab's
   *  conversation reattaches to it. */
  browseId: string;
}

// Persisted tab list — so a tab's browse-agent thread (keyed by `browseId`)
// reattaches after a reload. The native webview itself is recreated fresh at
// the saved URL; only url/title/browseId need to survive.
const TABS_KEY = "redline.browser.tabs";
// The last active tab id (regular browsing). Persisted separately from the tab
// list so a BrowserPane REMOUNT — which App triggers every time the document
// pane toggles on/off (it re-parents this pane into/out of the SplitPane) —
// restores the tab the user was on instead of snapping back to the first tab.
// Missions own their own active tab, so they don't write this key.
const ACTIVE_KEY = "redline.browser.activeId";
const newBrowseId = (): string =>
  typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `b-${Date.now()}-${Math.random().toString(36).slice(2)}`;

const freshHomeTab = (): Tab => {
  const browseId = newBrowseId(); const id = canonicalTabId(browseId);
  return { id, label: `browser-${id}`, url: HOME, title: initialBrowserTitle(HOME), browseId };
};

function loadTabs(): Tab[] {
  try {
    const raw = localStorage.getItem(TABS_KEY);
    if (raw) {
      const descriptors = JSON.parse(raw);
      if (Array.isArray(descriptors)) {
        const tabs = restoreBrowserTabs(descriptors, newBrowseId, initialBrowserTitle);
        // Migrate the active tab pointer together with legacy numeric tab IDs.
        const active = localStorage.getItem(ACTIVE_KEY);
        const previous = descriptors.find((tab) => tab?.id === active);
        const migrated = tabs.find((tab) => tab.browseId === previous?.browseId);
        if (migrated) localStorage.setItem(ACTIVE_KEY, migrated.id);
        if (tabs.length) return tabs;
      }
    }
  } catch { /* malformed saved data falls back to a usable new tab */ }
  return [freshHomeTab()];
}

interface Bookmark {
  title: string;
  url: string;
}

interface BrowserPaneProps {
  onPageContext?: (page: import("../lib/surfaceContext").BrowserIslandPage | null) => void;
  /** Close the browser (toggle it off). */
  onClose: () => void;
  onOpenDraft?: (draftId: string) => void;
  onMissionContinue?: (missionId: string, destination: "plan" | "auto", body: string, handoffId: string) => void;
  /** When false (e.g. a modal/overlay covers the pane), the native webview is
   *  hidden so it doesn't paint over the overlay. Defaults to true. */
  visible?: boolean;
  /** Surface selection, independent of temporary overlay occlusion. */
  surfaceActive?: boolean;
  /** Active file-explorer folder, if one is open — passed to the page-discussion
   *  agent as its working directory. */
  projectDir?: string | null;
  /** Ship the Task list into a fresh Redline plan session (terminal +
   *  `claude --permission-mode plan`). A page-chat reply hands off through
   *  its own Continue as… instead (BC-24). */
  onSendToRedline?: (markdown: string) => void;
  /** Open the Task list in the Prompt Drafter (repo pre-guessed) to shape
   *  before sending. One renderer feeds both handoffs (BC-16). */
  onSendToDrafter?: (markdown: string) => void;
  /** Seed the Prompt Drafter with a synthesized mission brief (markdown → Tiptap
   *  doc), so the user shapes the real document and ships it to Claude Code. */
  onSynthesizeToDrafter?: (markdown: string) => void;
  /** A request from elsewhere in the app to open a URL in a tab (today: "Open"
   *  on a Localhost dashboard card). Deliberately a PROP and not a Tauri event
   *  like `browse-open-tab`: this pane mounts only when the browser surface is
   *  selected, so an event emitted at the moment of selection would fire before
   *  the listener subscribes and be lost. `nonce` makes a repeat request for the
   *  SAME url still count as a new one. */
  openRequest?: {
    url: string;
    nonce: number;
    /** Send a turn in the opened tab's chat — Search from the plan hands its
     *  research ask over this way, and it goes out without moving the caret
     *  (`seedPolicy`'s plan Search). A chat request always opens a fresh
     *  tab, and its chat is that tab's own, never the shared one, whichever
     *  way linked mode leans (BC-6). */
    chat?: { text: string };
    /** Prefer an existing tab by its thread (a research comment's "View
     *  result"); falls back to opening `url` when that tab is gone. */
    focusBrowseId?: string;
    /** Just bring the tab back — don't open its chat (the Front Door's
     *  recent-tab pill). */
    quiet?: boolean;
  } | null;
  /** Called once the pane has acted on `openRequest`, so the owner clears it.
   *  Without this the request outlives its click: `lastOpenNonceRef` resets on
   *  every mount, so each browser-surface re-entry replayed the stale request
   *  and appended another tab. */
  onOpenRequestConsumed?: (browseId: string | null) => void;
  /** Opaque token that changes whenever a SURROUNDING App pane toggles (comment
   *  pane, sidebar, doc-split orientation/visibility, the conversation dock).
   *  These reflow the slot without a drag — and a `ResizeObserver` on the slot
   *  doesn't reliably catch the resulting geometry shift — so the native webview
   *  must be re-synced when it changes. The value itself is never read, only
   *  its identity. */
  layoutKey?: string;
  /** The conversation dock's slot for this pane's four panels.
   *
   *  They render INTO it through a portal rather than being lifted into App:
   *  everything they need — the tab list, `useMission`, the
   *  workspace swaps — is this pane's own state, and hoisting it would put the
   *  browser's state in two places to move its panels one level up. The pane
   *  keeps the state, the dock keeps the column. Null while the dock is closed
   *  or holding another surface's conversation. */
  dockSlot?: HTMLElement | null;
  /** Which of this pane's panels the dock is showing — the dock's context,
   *  translated back into the pane's own vocabulary. Null = none of them. */
  dockPill?: ChatPill | null;
  /** Ask the dock to show one of this pane's panels (and to open, if closed).
   *  Every internal "open the chat on X" already writes the per-tab memory;
   *  `setChatFor` forwards those writes here, so the call sites are unchanged. */
  onOpenDockPill?: (pill: ChatPill) => void;
  /** A panel's own ✕ — closes the dock, not just this panel. */
  onCloseDock?: () => void;
  /** The ids the dock needs to build its context list. Pushed on change; App
   *  clears it when this pane unmounts. */
  onDockState?: (s: BrowserDockState) => void;
}

const hostnameOf = (u: string): string => {
  try {
    return new URL(u).hostname || u;
  } catch {
    return u;
  }
};

function BrowserPaneBase({
  onClose,
  onPageContext,
  onOpenDraft,
  onMissionContinue,
  visible = true,
  surfaceActive = true,
  projectDir = null,
  onSendToRedline,
  onSendToDrafter,
  onSynthesizeToDrafter,
  openRequest = null,
  onOpenRequestConsumed,
  layoutKey,
  dockSlot = null,
  dockPill = null,
  onOpenDockPill,
  onCloseDock,
  onDockState,
}: BrowserPaneProps) {
  const slotRef = useRef<HTMLDivElement | null>(null);
  const tileSlotsRef = useRef(new Map<string, HTMLDivElement>());
  const tileIdsRef = useRef<string[]>([]);
  const [stageWidth, setStageWidth] = useState(window.innerWidth);
  const [bookmarksOpen, setBookmarksOpen] = useState(false);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [reloading, setReloading] = useState<Set<string>>(() => new Set());
  const reloadingRef = useRef(reloading); reloadingRef.current = reloading;
  const switchTiming = useRef<{ id: string; at: number } | null>(null);
  const [pageErrors, setPageErrors] = useState<Record<string, string>>({});
  const pageErrorsRef = useRef(pageErrors); pageErrorsRef.current = pageErrors;
  const nativeEpochRef = useRef(0);
  const nativeMountedRef = useRef(false);
  const surfaceActiveRef = useRef(surfaceActive); surfaceActiveRef.current = surfaceActive;
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [siteAppearances, setSiteAppearances] = usePersistedState<Record<string, BrowserAppearance>>("redline.browser.siteAppearance", {});
  const siteAppearancesRef = useRef(siteAppearances);
  siteAppearancesRef.current = siteAppearances;
  const [layoutMenuOpen, setLayoutMenuOpen] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [workspaceKey, setWorkspaceKey] = useState("regular");
  const [tileDragging, setTileDragging] = useState(false);
  const [hoveredTileTab, setHoveredTileTab] = useState<string | null>(null);
  const eventPagesRef = useRef(new Set<string>());
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const pendingWorkspaceSaveRef = useRef<{ workspaceId: string; value: Omit<SavedBrowserWorkspace, "revision"> } | null>(null);
  const [layouts, setLayouts] = usePersistedState<Record<string, BrowserLayout>>("redline.browser.layouts", {}, { debounceMs: 120 });
  const [groupsByWorkspace, setGroupsByWorkspace] = usePersistedState<Record<string, TabGroup[]>>("redline.browser.groups", {});
  const [organizedByWorkspace, setOrganizedByWorkspace] = usePersistedState<Record<string, boolean>>("redline.browser.organized", {});
  const [organizing, setOrganizing] = useState(false);
  const organizeEpoch = useRef(0);
  const organized = organizedByWorkspace[workspaceKey] ?? false;
  // Retired keys: the per-tab opt-out list (BC-R1) and the one-time cleanup
  // of the shared chats it left behind, which reading them now does.
  useEffect(() => { try { localStorage.removeItem("redline.browser.ownChatTabs"); localStorage.removeItem("redline.browser.followDefaultV1"); } catch { /* optional migration */ } }, []);

  // id → live Webview handle. Kept in a ref (not state) because these are
  // native resources we create/destroy imperatively, not render outputs.
  const wvMapRef = useRef<Map<string, Webview>>(new Map());
  const creatingRef = useRef<Set<string>>(new Set());
  const explicitlyClosedRef = useRef(new Set<string>());
  // Per-tab count of consecutive failed webview-creation attempts, so the
  // reconcile retry backs off and eventually gives up instead of spinning.
  // Reset to 0 the moment a webview is created successfully.
  const wakeAttemptsRef = useRef<Map<string, number>>(new Map());
  // When a failed creation may next retry, so the staggered reconcile — which
  // re-runs as each creation settles — still honors the backoff.
  const retryAtRef = useRef<Map<string, number>>(new Map());
  // Restore the persisted tab list once (stable across renders), and seed the
  // new-tab sequence above any restored id.
  const initialTabsRef = useRef<Tab[] | null>(null);
  if (!initialTabsRef.current) initialTabsRef.current = loadTabs();
  // Restore the last active tab (regular browsing) once, so a remount keeps the
  // view — and the single visible webview — on the tab the user was actually on,
  // not tab 0. Falls back to the first tab. Missions re-seed this via swap.
  const initialActiveRef = useRef<string | null>(null);
  if (initialActiveRef.current === null) {
    const restored = initialTabsRef.current;
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(ACTIVE_KEY);
    } catch {
      /* ignore — fall back to the first tab */
    }
    initialActiveRef.current =
      saved && restored.some((t) => t.id === saved) ? saved : restored[0].id;
  }
  // Which tab ids should have a live webview, and the recency order used to pick
  // suspend victims. Seeded with only the active tab — other restored tabs are
  // created lazily on first activation/wake (so reopening 8 tabs spawns 1 webview,
  // not 8). The reconcile effect only materializes tabs in `liveIntentRef`.
  const liveIntentRef = useRef<Set<string>>(
    new Set([initialActiveRef.current]),
  );
  const mruRef = useRef<string[]>([initialActiveRef.current]);
  const rafRef = useRef(0);
  // True while the user is editing the URL field, so polling doesn't clobber
  // what they're typing.
  const addrFocusedRef = useRef(false);

  // Debounced per-tab snapshot caching. Keeps the backend `SnapshotCache` fresh
  // (one debounce timer per tab id) so the browse agent can read / discuss a tab
  // even when its webview is later suspended or gone. Fired on navigation and
  // when a tab is backgrounded.
  const snapTimersRef = useRef<Map<string, number>>(new Map());
  // A picture of each tab, for the resize stand-in below. Kept as data URLs
  // keyed by tab id, refreshed on the same settle the DOM snapshot uses.
  const [tabShots, setTabShots] = useState<Map<string, string>>(
    () => new Map(),
  );
  const scheduleCacheSnapshot = useCallback((id: string, delay = 800) => {
    const captureMissionId = activeMissionIdRef.current;
    const timers = snapTimersRef.current;
    const prev = timers.get(id);
    if (prev) window.clearTimeout(prev);
    timers.set(
      id,
      window.setTimeout(() => {
        timers.delete(id);
        const label = `browser-${id}`;
        // The on-screen gate is ours to compute and only ours: WebKit snapshots
        // a hidden view as a blank frame and reports success, so the backend
        // has no way to know. Passing it lets the capture ride the same IPC
        // call that records the page — no window where the row exists without
        // its picture.
        const onScreen = tileIdsRef.current.includes(id) && visibleRef.current;
        void invoke("browser_cache_snapshot", { label, onScreen, missionId: captureMissionId }).catch(() => {});
        // Piggyback a picture on the same settle. Only the tab that is
        // actually on screen: WebKit snapshots a hidden view blank, and a
        // blank stand-in is worse than none. Deliberately here rather than at
        // drag start — a capture then would be exactly the hitch we're
        // removing, so a drag uses whatever picture already exists.
        if (!tileIdsRef.current.includes(id) || !visibleRef.current) return;
        const el = slotRef.current;
        const width = Math.round((tileSlotsRef.current.get(id) ?? el)?.getBoundingClientRect().width ?? 0);
        if (width < 64) return;
        void (async () => {
          try {
            const shot = await invoke<{ path: string }>(
              "browser_take_thumbnail",
              { label, key: `tab-${id}`, width },
            );
            const file = await invoke<BinaryFile>("read_file_base64", {
              path: shot.path,
            });
            if (!file.data) return;
            const url = `data:image/png;base64,${file.data}`;
            setTabShots((prev) => {
              // The tab closed while its picture was being taken.
              if (!tabsRef.current.some((t) => t.id === id)) return prev;
              const next = new Map(prev);
              next.set(id, url);
              return next;
            });
          } catch {
            /* no picture for this tab — the drag falls back to blank */
          }
        })();
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
      retryAtRef.current.delete(id);
      setLiveVersion((v) => v + 1);
    }
  }, []);
  // Move a tab to the front of the recency order (most-recently-used first).
  const touchMru = useCallback((id: string) => {
    mruRef.current = [id, ...mruRef.current.filter((x) => x !== id)];
  }, []);

  const [tabs, setTabs] = useState<Tab[]>(initialTabsRef.current);
  const [activeId, setActiveId] = useState(() => initialActiveRef.current!);
  const picker = useElementPicker(`browser-${activeId}`, setWorkspaceError);
  const pickerRef = useRef(picker); pickerRef.current = picker;
  // The pages the agent is acting on: a dot on each tab, and the running
  // action named in the page chat's live line (BC-41).
  const pageActions = usePageActions();
  // The page chat's scope: which thread it shows and which page a turn
  // targets. That is the structure layer's world, built from these tabs, the
  // tab on screen and the workspace plus a slice only its reducer writes; the
  // two diverge when an agent opens a tab on the conversation's behalf (the
  // page comes forward, the conversation stays anchored, BC-5). Every gesture
  // that moves the conversation dispatches an event, and nothing here derives
  // a thread id. See lib/browserChat/README.md.
  const { world: chatWorld, dispatch: dispatchChat } = useChatWorld({ workspace: workspaceKey, tabs, activeId }, newBrowseId);
  // By value: the world is rebuilt every render, and the memoized page chat
  // takes this as a prop.
  const conversation = useStableValue(resolveConversation(chatWorld));
  const [addr, setAddr] = useState(
    () =>
      initialTabsRef.current!.find((t) => t.id === initialActiveRef.current)
        ?.url ?? initialTabsRef.current![0].url,
  );
  // The discussion panel's memory, PER TAB and persisted.
  //
  // This was a plain `useState` pair, and that was the bug: `BrowserPane` is
  // unmounted whenever the main surface changes (App mounts it only while
  // `mainSurface === "browser"`) and re-parented on every document-pin toggle,
  // so a round-trip to Code Review closed the chat every single time and there
  // was no way to say "leave it as I had it". Keyed on `browseId` — the tab's
  // durable id — so the panel reopens on the tab the user left it open on,
  // through a reload and a mission restore, not on whatever tab inherited its
  // slot. See lib/browseChatState.ts.
  const [chatState, setChatState] = usePersistedState<ChatStateMap>(
    "redline.browser.chatState",
    {}, { debounceMs: 120 },
  );
  // Keyed on the ACTIVE tab, not the anchored conversation: the memory should
  // follow the tab the user is looking at, and those two deliberately diverge
  // when an agent opens a tab on the current conversation's behalf.
  const activeBrowseId =
    (tabs.find((t) => t.id === activeId) ?? tabs[0])?.browseId ?? null;
  const groups = reconcileGroups(groupsByWorkspace[workspaceKey] ?? [], tabs);
  const setGroups = (next: TabGroup[]) => setGroupsByWorkspace(prev => ({ ...prev, [workspaceKey]: next }));
  const organizeTabs = async (fileOnly = false) => {
    const epoch = ++organizeEpoch.current, key = workspaceKey, snapshot = tabs;
    setOrganizing(true);
    try {
      const result = await invoke<TabGroup[]>("browser_organize_tabs", { tabs: snapshot.map(tab => ({ browseId: tab.browseId, title: tab.title, url: tab.url })), groups, fileOnly });
      if (epoch === organizeEpoch.current && workspaceKeyRef.current === key) setGroups(validateGroups(result, snapshot) ? reconcileGroups(result, tabsRef.current) : fallbackGroups(tabsRef.current));
    } catch { if (epoch === organizeEpoch.current && workspaceKeyRef.current === key) setGroups(fallbackGroups(tabsRef.current)); }
    finally { if (epoch === organizeEpoch.current) setOrganizing(false); }
  };
  const organizeRef = useRef(organizeTabs); organizeRef.current = organizeTabs;
  const groupMembership = groups.map(group => `${group.id}:${group.browseIds.join(",")}`).join("|");
  useEffect(() => {
    if (!organized || !groups.some(group => group.id === "unfiled")) return;
    const timer = window.setTimeout(() => void organizeRef.current(true), 3000);
    return () => window.clearTimeout(timer);
  }, [organized, groupMembership, workspaceKey]);
  const chatHere = chatEntryFor(chatState, activeBrowseId);
  // Which panel is up is the DOCK's answer now — one column, one open bit, one
  // place in the app that knows what conversation you are in. `chatState`
  // survives as what it always really was underneath: the per-tab MEMORY of
  // where you left each tab, which is what the dock leads with when you come
  // back to it (`conversationContexts`' `browsePill`).
  const chatOpen = dockPill != null;
  const chatTab = dockPill ?? chatHere.pill;
  const activeBrowseIdRef = useRef(activeBrowseId);
  activeBrowseIdRef.current = activeBrowseId;
  const dockPillRef = useRef(dockPill);
  dockPillRef.current = dockPill;
  /** Write one tab's panel state. Every old `setChatOpen`/`setChatTab` pair
   *  becomes one of these — the change surface is exactly the call sites.
   *
   *  It also forwards to the dock, which is what keeps those ~10 call sites
   *  untouched by the fold: `{open: true, pill}` means "show me this", and a
   *  bare `{pill}` retargets only a column that is already up (the localhost
   *  list offer is a nudge, not an interruption). */
  const setChatFor = useCallback(
    (browseId: string | null, patch: { open?: boolean; pill?: ChatPill }) => {
      if (!browseId) return;
      setChatState((prev) => withChatPatch(prev, browseId, patch, Date.now()));
      if (patch.open === false) onCloseDock?.();
      else if (patch.pill && (patch.open === true || dockPillRef.current != null))
        onOpenDockPill?.(patch.pill);
    },
    [setChatState, onOpenDockPill, onCloseDock],
  );
  // Dock tab clicks also update the current page's pill memory.
  useEffect(() => {
    if (dockPill && activeBrowseIdRef.current) setChatState(prev => withChatPatch(prev, activeBrowseIdRef.current!, { pill: dockPill }, Date.now()));
  }, [dockPill, setChatState]);
  /** …and this one for the common case: the tab the user is on right now. */
  const setChatHere = useCallback(
    (patch: { open?: boolean; pill?: ChatPill }) =>
      setChatFor(activeBrowseIdRef.current, patch),
    [setChatFor],
  );
  // Text handed to the page-discussion composer once (`💬` on a list item).
  // A prop with a nonce, not a write to the composer's persisted localStorage
  // key — that would desync `usePersistedState`'s in-memory copy whenever the
  // panel is already mounted. Same shape as `openRequest` below.
  const [chatSeed, setChatSeed] = useState<{
    text: string;
    nonce: number;
    /** The gesture it came from. The chat asks `seedPolicy` whether that
     *  sends at once (the one-tap highlight intents, a plan Search) and
     *  whether it places the caret (only a gesture whose point is typing
     *  next, BC-33). */
    source: SeedSource;
  } | null>(null);
  // Page actions must reveal their destination before a mounted background
  // conversation can consume the seed (including one-tap auto-send actions).
  const seedPageChat = useCallback((seed: NonNullable<typeof chatSeed>) => {
    setChatSeed(seed);
  }, []);
  // Bumped after a highlight writes into a list, so an already-open list panel
  // remounts and shows the item instead of silently going stale (it loads from
  // the DB on mount and has no reason to poll).
  const [listReloadKey, setListReloadKey] = useState(0);
  // Synthesize from the page chat's goal card, waiting for the Mission panel
  // to mount and run it. Consumed once started, like a seed.
  const [synthesizeAsked, setSynthesizeAsked] = useState(false);

  /** One read of the live page: where it is, and what is highlighted on it.
   *
   *  Two facts the working list needs and could not get. The tab's polled
   *  `url` is a second stale at worst, but the `title` it carries is only ever
   *  the hostname, and the highlighted element was never reachable at all —
   *  the selection lives in an OS-composited child webview that the host
   *  document's `getSelection()` cannot see.
   *
   *  `__redline_sel_last` is published by the selection shim; `location.href`
   *  and `document.title` are read straight from the page, so a capture still
   *  works with highlight actions switched off (no shim → no selection, which
   *  is exactly right: with the bar gone the user cannot see what they would be
   *  anchoring to). Reuses the proven string-returning eval — no new plumbing. */
  const capturePage = useCallback(async (): Promise<PageContext | null> => {
    const id = activeIdRef.current;
    if (!wvMapRef.current.has(id)) return null;
    // The panel polls this while it is mounted, and it stays mounted under a
    // surface that covers the pane. Nobody is highlighting a page they cannot
    // see, so the honest answer there is "nothing" — and it costs no eval.
    if (!visibleRef.current || document.hidden) return null;
    try {
      const raw = await invoke<string>("browser_eval_result", {
        label: `browser-${id}`,
        script:
          "(function(){try{return JSON.stringify({url:location.href," +
          "title:document.title||'',sel:window.__redline_sel_last||null})}" +
          'catch(e){return "{}"}})()',
      });
      return parsePageContext(JSON.parse(raw || "{}"));
    } catch {
      // A page that refuses the eval, or a webview torn down mid-capture. The
      // item is still written — unplaced, which is what it was before.
      return null;
    }
  }, []);

  /** Hand one item to the background naming agent.
   *
   *  Fire-and-forget on purpose: the item is already written and already
   *  carries the deterministic pointer, so this is a refinement racing nothing.
   *  It reports through the `browse-list-located` event rather than a return
   *  value, so the panel updates whether or not the caller is still mounted —
   *  and a rejection here is a no-op, never a visible failure on a write that
   *  already succeeded. */
  const refineLocator = useCallback(
    (itemId: string, selection: string, locator: RawLocator | null) => {
      if (!locator) return;
      void invoke("browse_list_locate", {
        itemId,
        selection,
        elementJson: JSON.stringify(locator).slice(0, 4000),
      }).catch(() => {});
    },
    [],
  );

  const addSelectionToCart = useCallback(async (ev: SelectionEvent) => {
    const workspace = workspaceKey;
    try {
      await ensureCart(workspace);
      const item = await invoke<{ id: string }>("browse_list_add", {
        browseId: cartKey(workspace), kind: "note", body: ev.note,
        pageUrl: ev.url || null, pageTitle: ev.title || null,
        locator: fallbackLocator(ev.locator) || null,
      });
      refineLocator(item.id, ev.text, ev.locator);
      if (workspaceKeyRef.current !== workspace) return;
      setListReloadKey(n => n + 1);
      setChatHere({ open: true, pill: "cart" });
    } catch (error) { setWorkspaceError(`Could not add to task list: ${String(error)}`); }
  }, [workspaceKey, setChatHere, refineLocator]);

  const addReplyToCart = async (body: string): Promise<boolean> => {
    const workspace = workspaceKey;
    const tab = tabsRef.current.find(page => page.id === activeIdRef.current);
    const page = await capturePage();
    try {
      await ensureCart(workspace);
      await invoke("browse_list_add", { browseId: cartKey(workspace), kind: "note", body,
        pageUrl: page?.url ?? tab?.url ?? null, pageTitle: page?.title ?? tab?.title ?? null });
      if (workspaceKeyRef.current === workspace) setListReloadKey(n => n + 1);
      return true;
    } catch (error) { setWorkspaceError(`Could not add to task list: ${String(error)}`); return false; }
  };

  /** One action off the in-page selection bar.
   *
   *  The passage the user highlighted is the best grounding signal the page can
   *  give the browse agent, and until now it was thrown away — `SNAPSHOT_JS`
   *  has always captured `window.getSelection()` into `snapshot.selection` and
   *  nothing has ever read it. `ask` seeds the composer and waits for their
   *  question; the one-tap intents are already complete instructions and send
   *  themselves; ＋ List never becomes a chat turn at all. `Copy` never arrives
   *  here — the shim does it in-page, inside the click's user activation. */
  const dispatchSelection = useCallback(
    (ev: SelectionEvent, nonce: number) => {
      const source: SeedSource = ev.action === "list"
        ? { kind: "selection-list" }
        : { kind: "selection", action: ev.action, note: ev.note };
      if (!seedPolicy(source).toChat) {
        void addSelectionToCart(ev);
        return;
      }
      // The seed lands in the conversation on screen. That is normally the
      // active tab's; when an agent opened the page and the conversation
      // stayed anchored, the anchored one is exactly the one that should
      // hear what the user highlighted on the page it opened.
      seedPageChat({ text: promptForSelection(ev), nonce, source });
      setChatHere({ open: true, pill: "page" });
    },
    [addSelectionToCart, setChatHere, seedPageChat],
  );
  // The 250 ms poll below runs on a `[]`-deps effect; read through a ref so it
  // never has to resubscribe (same pattern as `openTabRef`).
  const dispatchSelectionRef = useRef(dispatchSelection);
  dispatchSelectionRef.current = dispatchSelection;

  // Research-mission state (active mission, its pins, the resumable list).
  // Mirrors itself to the backend so the daemon's /v1/mission/* routes can
  // answer the orchestrator. See useMission.
  const mission = useMission();
  // Ownership changes only when the corresponding page set commits. A mission
  // creation/restore can resolve before its tabs; never save the old pages to it.
  const tileLayout = normalizeBrowserLayout(layouts[workspaceKey] ?? layouts.default ?? DEFAULT_BROWSER_LAYOUT);
  const layoutsRef = useRef(layouts); layoutsRef.current = layouts;
  const layoutSnapshotKey = JSON.stringify(tileLayout);
  const updateTileLayout = (patch: Partial<BrowserLayout>) => setLayouts((prev) => ({ ...prev, [workspaceKey]: { ...normalizeBrowserLayout(prev[workspaceKey] ?? prev.default), ...patch } }));
  // Escape (from Redline or from inside a page) restores a maximized tile.
  const updateTileLayoutRef = useRef(updateTileLayout); updateTileLayoutRef.current = updateTileLayout;
  const forgetNativeRef = useRef<(id: string, recreate: boolean) => void>(() => {});
  const restoreTilesRef = useRef(() => {});
  restoreTilesRef.current = () => { if (tileLayout.maximized) updateTileLayout({ maximized: null }); };

  // The "Start a mission" / "what's our goal" dialog.
  const [missionDialogOpen, setMissionDialogOpen] = useState(false);
  const [missionFoundationOpen, setMissionFoundationOpen] = useState(false);
  const [missionMenuOpen, setMissionMenuOpen] = useState(false);
  // Mosaics: the manager, the editor, the open mosaic's definition, and the
  // workspace to return to when it closes (regular browsing or a mission).
  const [mosaicsOpen, setMosaicsOpen] = useState(false);
  const [mosaicList, setMosaicList] = useState<MosaicSummary[] | null>(null);
  // A deleted mission's or mosaic's shared chat is forgotten once a fresh
  // read of its list says so; the persisted map holds only live workspaces.
  // Each list speaks for its own kind as it arrives, and only then: the
  // mosaics' is read when their manager opens (`refreshMosaics`), so sending
  // it again later would forget a mosaic saved since.
  useEffect(() => {
    if (mission.missionsLoaded) dispatchChat({ type: "workspaces-listed", missions: mission.missions.map((m) => m.missionId), mosaics: null });
  }, [mission.missionsLoaded, mission.missions, dispatchChat]);
  const [mosaicError, setMosaicError] = useState<string | null>(null);
  const [mosaicEdit, setMosaicEdit] = useState<{ draft: MosaicDraft; previous: Mosaic | null } | null>(null);
  const [activeMosaic, setActiveMosaic] = useState<Mosaic | null>(null);
  const [startupMosaic, setStartupMosaic] = usePersistedState<string | null>(STARTUP_MOSAIC_KEY, null);
  const mosaicReturnRef = useRef("regular");
  // Adopted native pages of a just-opened mosaic still show wherever they
  // were left; these tiles navigate back to their saved address once live.
  const homeNavigateRef = useRef(new Set<string>());
  // The ▾ missions menu rides beside 🎯 only once at least one mission exists to
  // manage (switch / resume / delete / start another). With none, the bare 🎯
  // is "start a mission" and the caret would be a dead control.
  // The active mission id, readable inside the `[tabs]`-keyed persistence effect
  // and the swap callbacks without adding mission state to their deps.
  const activeMissionIdRef = useRef<string | null>(null);
  activeMissionIdRef.current = workspaceKey === "regular" || isMosaicWorkspace(workspaceKey) ? null : workspaceKey;
  // True during a full workspace swap, so the persistence effect doesn't write
  // the transient mid-swap tab state to a bucket. Cleared by the `[tabs]`
  // effect itself when the swapped-in set (held in `swapCommitRef`) commits —
  // NOT synchronously at the end of the swap, which ran before that effect and
  // re-enabled persistence one commit too early (mission tabs leaking into the
  // regular bucket, and vice versa).
  const swappingRef = useRef(false);
  const swapCommitRef = useRef<Tab[] | null>(null);
  // Mount-time mission-tab restore runs at most once.
  const initDoneRef = useRef(false);
  // While a persisted mission's workspace hasn't been swapped in yet, this
  // pane is showing the REGULAR bucket's tabs under a mission-owned session —
  // persisting or mirroring that state would write the wrong tab set to the
  // mission bucket / the daemon. Seeded from the raw persisted id (available
  // synchronously, unlike the mission list) and cleared when the restore
  // resolves — by swapping, or by discovering the mission no longer exists.
  const missionRestorePendingRef = useRef<boolean | null>(null);
  if (missionRestorePendingRef.current === null) {
    missionRestorePendingRef.current = true;
  }
  // The same fact as state, for the one reader that must WAIT for the restore
  // rather than skip while it is pending: an open request that arrives with
  // the first mount (a plan Search, "View result") would open its tab into the
  // set the restore is about to replace, and the tab would vanish with its
  // chat's research turn still waiting to send into whatever chat was left.
  const [workspaceRestored, setWorkspaceRestored] = useState(false);
  const endRestore = () => { missionRestorePendingRef.current = false; setWorkspaceRestored(true); };
  // Debounce timer for saving the active mission's tab workspace.
  const missionTabsTimerRef = useRef<number | null>(null);
  // Tab drag-to-reorder. `tabDragging` hides the native webview during a drag
  // (so it doesn't swallow the pointer, same rule as the split divider);
  const [tabDragging, setTabDragging] = useState(false);
  // Live drag bookkeeping read by the window pointer listeners without stale
  // closures: the tab being dragged, whether the pointer has moved past the
  // click threshold, and the current drop target.

  // Set true on pointer-up of a real drag so the follow-up click doesn't also
  // fire `selectTab` (a drag shouldn't switch tabs).
  const suppressTabClickRef = useRef(false);
  const videoFs = useVideoFullscreen(activeId, surfaceActive, setWorkspaceError);
  const videoFsRef = useRef(videoFs); videoFsRef.current = videoFs;
  const browserFullscreen = videoFs.stage !== "off";
  const takeoverRef = useRef(false); takeoverRef.current = videoFs.stage === "screen";
  const visibleBrowseIds = browserFullscreen ? [activeBrowseId!] : visibleTileIds(tileLayout, tabs.map((t) => t.browseId), activeBrowseId!, stageWidth);
  const tilePages = visibleBrowseIds.map((id) => tabs.find((t) => t.browseId === id)!).filter(Boolean);
  tileIdsRef.current = tilePages.map((t) => t.id);
  // The grid actually drawn — narrowed to the stage, gone while one page fills
  // it. A projection handed to the stage; the saved layout keeps its grid.
  const stageGrid = browserFullscreen ? undefined : visibleGrid(tileLayout, tabs.map((t) => t.browseId), stageWidth);
  const stageLayout = tileLayout.grid ? { ...tileLayout, grid: stageGrid } : tileLayout;
  const tileGeometryKey = `${visibleBrowseIds.join(",")}|${tileLayout.horizontal}|${tileLayout.vertical}|${browserFullscreen}|${tileLayout.maximized}|${stageGrid ? `${stageGrid.rows}x${stageGrid.cols}` : ""}`;

  const [bookmarks, setBookmarks] = usePersistedState<Bookmark[]>(
    "redline.browser.bookmarks",
    [],
  );
  // Highlight-to-chat: the in-page action bar that pops when you finish
  // selecting text (Ask about this · Define · Explain · Research · Copy ·
  // ＋ List). On by default — it replaces select/copy/open-chat/paste/type with
  // one tap — but it draws inside someone else's page, so it stays a toggle.
  // The flag is passed to the native side, which installs (or tears down) the
  // shim; see `selection_shim_js` in lib.rs.
  const [selectionActions, setSelectionActions] = usePersistedState<boolean>(
    "redline.browser.selectionActions",
    true,
  );
  // Read from tab creation and the settings-menu handler without re-subscribing.
  const selectionActionsRef = useRef(selectionActions);
  selectionActionsRef.current = selectionActions;
  // Mirror state into refs so the async webview callbacks read current values.
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  useEffect(() => {
    setTabShots((prev) => shotsForOpenTabs(prev, tabs));
  }, [tabs]);
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  // Tell the dock which conversations exist beside this pane. Only ids and
  // labels cross — the panels themselves stay here and are portalled into the
  // dock's slot, so this is a description, never a second copy of the state.
  //
  // The page entry is the conversation the layer resolves, whether or not the
  // column is showing it: a shared chat already has its thread (BC-10).
  const dock = dockDescriptor(chatWorld);
  const dockBrowseId = dock?.browseId ?? null;
  const dockTitle = dock?.title ?? null;
  const workspaceKeyRef = useRef(workspaceKey); workspaceKeyRef.current = workspaceKey;
  const dockCartId = cartKey(workspaceKey);
  const dockMissionId = mission.activeMission?.missionId ?? null;
  const dockMissionTitle = mission.activeMission?.title ?? null;
  const dockMemoPill = chatHere.pill;
  useEffect(() => {
    onDockState?.({
      browseId: dockBrowseId,
      title: dockTitle,
      pill: dockMemoPill,
      cartId: dockCartId,
      missionId: dockMissionId,
      missionTitle: dockMissionTitle,
    });
  }, [
    onDockState,
    dockBrowseId,
    dockTitle,
    dockMemoPill,
    dockCartId,
    dockMissionId,
    dockMissionTitle,
  ]);
  // True for the length of any drag anywhere in the app. The native webview
  // cannot ride a drag — it is a sibling OS view that always paints above the
  // main webview and steals the pointer at the OS level, so DOM pointer capture
  // can't save it and it must hide. What it must NOT do is leave a blank
  // rectangle: for the duration, the tab's last picture stands in.
  const [resizing, setResizing] = useState(false);
  useEffect(() => onResizeSession(setResizing), []);

  // The native webview is hidden whenever the pane is logically hidden, the
  // chat divider is being dragged, or an HTML overlay we own is up (the mission
  // start dialog / menu) — a native webview paints OVER React DOM, so it must
  // step aside for those, the same reason bookmarks use a native popup menu.
  const effectiveVisible =
    visible && surfaceActive && !resizing && !bookmarksOpen && !preferencesOpen &&
    !tabDragging &&
    !tileDragging &&
    !layoutMenuOpen &&
    !overflowOpen &&
    !appearanceOpen &&
    !missionDialogOpen &&
    !missionFoundationOpen &&
    !missionMenuOpen &&
    !mosaicsOpen &&
    !mosaicEdit;
  const visibleRef = useRef(effectiveVisible);
  visibleRef.current = effectiveVisible;

  // Persist the tab list (url/title/browseId) so a tab's discussion thread
  // reattaches after reload, and mirror it into the backend so the browse
  // agent's `/v1/browser/tabs` registry + cross-tab routes can resolve a tab
  // selector to a webview label / discussion thread.
  useEffect(() => {
    // A persisted mission's workspace hasn't been swapped in yet: these are
    // the regular bucket's tabs on a mission-owned session. Don't persist
    // them to any bucket AND don't mirror them to the daemon — the mission's
    // agents would act on the wrong tab set.
    if (missionRestorePendingRef.current) return;
    if (swappingRef.current) {
      // Swap mid-flight: skip bucket persistence (the swap saves buckets
      // explicitly; persisting the transient state would cross-contaminate
      // them). The swap is complete when ITS tab set commits — matched by
      // identity — which is where the flag clears; that commit itself is
      // still skipped.
      if (tabs === swapCommitRef.current) {
        swappingRef.current = false;
        swapCommitRef.current = null;
      }
    } else {
      const descs = tabs.map((t) => ({
        id: t.id,
        url: t.url,
        title: t.title,
        browseId: t.browseId, favicon: t.favicon,
      }));
      const mid = activeMissionIdRef.current;
      if (mid) {
        // A mission owns this workspace → persist to it (debounced SQLite write).
        if (missionTabsTimerRef.current) window.clearTimeout(missionTabsTimerRef.current);
        missionTabsTimerRef.current = window.setTimeout(() => {
          void mission.setMissionTabs(mid, descs).catch((e) => setWorkspaceError(String(e)));
        }, 500);
      } else if (workspaceKeyRef.current === "regular") {
        // Regular browsing → the global bucket. (A mosaic persists only
        // through its workspace row, saved below.)
        try {
          localStorage.setItem(TABS_KEY, JSON.stringify(descs));
        } catch {
          /* ignore — tabs still work in-memory */
        }
      }
    }
    // Keep the per-tab chat memory bounded — without this the map grows for
    // the life of the install. Live tabs are never dropped, and closed ones
    // only past a cap: `tabs` is one WORKSPACE, so evicting everything absent
    // from it would forget the regular tabs the moment a mission swaps in.
    setChatState((prev) => pruneChatState(prev, tabs.map((t) => t.browseId)));

    // Mirror the live tab list to the daemon, so the orchestrator and page
    // agents see the current tabs (independent of which bucket persists).
    void invoke("browser_set_tabs", {
      list: tabs.map((t) => ({
        id: t.id,
        label: t.label,
        url: t.url,
        title: t.title,
        browseId: t.browseId, favicon: t.favicon,
      })),
    }).catch(() => {});
  }, [tabs]);

  useEffect(() => {
    if (missionRestorePendingRef.current || swappingRef.current) return;
    const pending = { workspaceId: workspaceKey, value: { tabs: tabs.map((tab) => ({ id: tab.id, browseId: tab.browseId, title: tab.title, url: tab.url, favicon: tab.favicon })), layout: tileLayout, groups, organized } };
    pendingWorkspaceSaveRef.current = pending;
    const timer = window.setTimeout(() => {
      if (pendingWorkspaceSaveRef.current === pending) pendingWorkspaceSaveRef.current = null;
      void saveBrowserWorkspace(pending.workspaceId, pending.value).catch((error) => setWorkspaceError(`Workspace save failed: ${String(error)}`));
    }, 500);
    return () => window.clearTimeout(timer);
  }, [tabs, workspaceKey, layoutSnapshotKey, groupMembership, groupsByWorkspace, organized]);
  useEffect(() => () => {
    const pending = pendingWorkspaceSaveRef.current;
    pendingWorkspaceSaveRef.current = null;
    if (pending) void saveBrowserWorkspace(pending.workspaceId, { ...pending.value, layout: pending.value.layout ? { ...pending.value.layout, focused: activeBrowseIdRef.current } : undefined }).catch((error) => console.error("Browser workspace could not be saved on close", error));
  }, []);

  // Mirror the active tab into the backend so the browse agent's
  // `/v1/browser/*` daemon routes act on the tab the user is looking at.
  useEffect(() => {
    void invoke("browser_set_active", { label: `browser-${activeId}` }).catch(
      () => {},
    );
    // Remember the active tab so a remount (document-pane toggle) restores it.
    // Skip while a mission owns the workspace, a swap is mid-flight, or a
    // mission restore is still pending — those states aren't the global
    // regular-browsing one.
    if (
      workspaceKeyRef.current === "regular" &&
      !swappingRef.current &&
      !missionRestorePendingRef.current
    ) {
      try {
        localStorage.setItem(ACTIVE_KEY, activeId);
      } catch {
        /* ignore — restore just falls back to the first tab */
      }
    }
  }, [activeId]);
  // Clear it when the browser pane goes away.
  useEffect(
    () => () => {
      void invoke("browser_set_active", { label: null }).catch(() => {});
    },
    [],
  );

  const activeUrl = tabs.find((t) => t.id === activeId)?.url ?? "";
  const activeTitle = tabs.find(tab => tab.id === activeId)?.title ?? "";
  useEffect(() => { onPageContext?.({ label: `browser-${activeId}`, url: activeUrl, title: activeTitle }); }, [activeId, activeUrl, activeTitle, onPageContext]);
  useEffect(() => () => onPageContext?.(null), [onPageContext]);
  const activeUrlRef = useRef(activeUrl);
  activeUrlRef.current = activeUrl;

  // A shared per-label drain serializes geometry, show and hide, even when a
  // view finishes creating after a workspace change or StrictMode cleanup.
  const geometryRef = useRef<ReturnType<typeof createNativeBrowserGeometry<Webview>> | null>(null);
  if (!geometryRef.current) geometryRef.current = createNativeBrowserGeometry<Webview>({
    setPosition: (view, rect) => view.setPosition(new LogicalPosition(rect.x, rect.y)),
    setSize: (view, rect) => view.setSize(new LogicalSize(rect.w, rect.h)),
    show: (view) => view.show(), hide: (view) => view.hide(),
    onError: (id) => {
      if (nativeMountedRef.current && visibleRef.current && tileIdsRef.current.includes(id) && wvMapRef.current.has(id)) {
        setPageErrors((prev) => prev[id] ? prev : { ...prev, [id]: "This page could not be displayed. Try opening it again." });
      }
    },
  });
  const geometry = geometryRef.current;
  useLayoutEffect(() => {
    nativeMountedRef.current = true; geometry.start();
    return () => { nativeMountedRef.current = false; nativeEpochRef.current++; geometry.stop(); };
  }, [geometry]);
  const measureTiles = useCallback(() => [...wvMapRef.current].map(([id, view]) => ({ id, view,
    rect: visibleRef.current && !reloadingRef.current.has(id) && !pageErrorsRef.current[id] && tileIdsRef.current.includes(id)
      ? takeoverRef.current && id === activeIdRef.current ? fullWindowRect({ width: window.innerWidth, height: window.innerHeight })
        : measureNativeBrowserRect(tileSlotsRef.current.get(id), slotRef.current) : null,
  })), []);
  const syncBounds = useCallback(() => { geometry.sync(measureTiles()); }, [geometry, measureTiles]);
  useLayoutEffect(() => { syncBounds(); }, [pageErrors, reloading, syncBounds]);
  // Hide before paint whenever an overlay or another surface takes ownership.
  useLayoutEffect(() => { if (!effectiveVisible) geometry.hideAll(); }, [effectiveVisible, geometry]);
  useEffect(() => {
    if (surfaceActive) return;
    setOverflowOpen(false); setLayoutMenuOpen(false); setAppearanceOpen(false);
    setBookmarksOpen(false); setPreferencesOpen(false); setMissionMenuOpen(false);
    setMissionDialogOpen(false); setMissionFoundationOpen(false);
    setMosaicsOpen(false); setMosaicEdit(null);
  }, [surfaceActive]);

  // Coalesce the rapid bursts a divider drag produces into one update/frame.
  const scheduleSync = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      syncBounds();
    });
  }, [syncBounds]);

  const ensureTab = useCallback(
    async (tab: Tab): Promise<{ view: Webview; adopted: boolean }> => {
      // Reuse an existing webview with this label if one is still alive (a
      // StrictMode remount or cancelled teardown left it around) — recreating
      // it would either flash or error on the duplicate label.
      const profile = normalizeAppearance(siteAppearancesRef.current[siteKey(tab.url)]);
      const existing = await Webview.getByLabel(tab.label).catch(() => null);
      const adopt = async (view: Webview) => ({ view, adopted: true });
      const create = async (): Promise<Webview> => {
        await invoke("browser_create_tab", { label: tab.label, url: tab.url, css: appearanceCss(profile), website: profile.website, zoom: profile.zoom, selectionActions: selectionActionsRef.current });
        const view = await Webview.getByLabel(tab.label);
        if (!view) throw new Error("The page's view did not open");
        return view;
      };
      if (existing) { await create(); return adopt(existing); }
      // A just-suspended tab's webview may still be mid-teardown (close() is
      // async); recreating the same live label would throw. If creation fails,
      // wait for the old webview to actually disappear, then retry once.
      let wv: Webview;
      try {
        wv = await create();
      } catch (firstErr) {
        // A background mission action may have created the same durable page
        // after our lookup. Adopt it instead of retrying a duplicate native ID.
        const raced = await Webview.getByLabel(tab.label).catch(() => null);
        if (raced) return adopt(raced);
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
      return { view: wv, adopted: false };
    },
    [],
  );

  // Reconcile native webviews against the tab list: create the tabs that *want*
  // a live webview (`liveIntentRef`), close orphaned. A tab in the list but not
  // in `liveIntentRef` is suspended (no webview) — left alone here. Creation is
  // async and guarded against StrictMode double-mount.
  useEffect(() => {
    const now = Date.now();
    // The active page first, then the other visible tiles, then the rest.
    const rank = (tab: Tab) => tab.id === activeIdRef.current ? 0 : tileIdsRef.current.includes(tab.id) ? 1 : 2;
    for (const tab of [...tabs].sort((a, b) => rank(a) - rank(b))) {
      if (
        tab.url === NEWTAB ||
        !liveIntentRef.current.has(tab.id) ||
        wvMapRef.current.has(tab.id) ||
        creatingRef.current.has(tab.id) ||
        (retryAtRef.current.get(tab.id) ?? 0) > now
      ) {
        continue;
      }
      // Staggered: the next waiting page starts when one of these settles.
      if (creatingRef.current.size >= MAX_CONCURRENT_CREATES) break;
      creatingRef.current.add(tab.id);
      const epoch = nativeEpochRef.current;
      ensureTab(tab)
        .then(({ view: wv, adopted }) => {
          creatingRef.current.delete(tab.id);
          if (nativeMountedRef.current) setLiveVersion((v) => v + 1);
          // A workspace may have left while creation was in flight. Preserve
          // its native state for the background manager, but never show it here.
          const stillWanted = tabsRef.current.some((t) => t.id === tab.id && t.browseId === tab.browseId);
          if (!nativeMountedRef.current || epoch !== nativeEpochRef.current || !stillWanted) {
            geometry.hide(tab.id, wv);
            if (explicitlyClosedRef.current.has(tab.id)) closeWebview(tab.label);
            else if (nativeMountedRef.current && stillWanted) setLiveVersion((v) => v + 1);
            return;
          }
          setPageErrors((prev) => { if (!prev[tab.id]) return prev; const next = { ...prev }; delete next[tab.id]; return next; });
          wvMapRef.current.set(tab.id, wv);
          wakeAttemptsRef.current.delete(tab.id); // created → clear retry count
          retryAtRef.current.delete(tab.id);
          setReloading(prev => { const next = new Set(prev); next.delete(tab.id); return next; });
          // A just-opened mosaic shows today's page, not where it was left: a
          // fresh view already loads `tab.url`, an adopted one is sent there.
          const goHome = homeNavigateRef.current.delete(tab.id);
          if (goHome && adopted) void invoke("browser_navigate", { label: tab.label, url: tab.url }).catch(() => {});
          // If this tab was suspended, restore its scroll once the page loads.
          // There's no load event, so retry the scrollTo a few times.
          void invoke<[number, number] | null>("browser_consume_scroll", {
            label: tab.label,
          })
            .then((pos) => {
              if (!pos || goHome) return;
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
          syncBounds();
          if (switchTiming.current?.id === tab.id) { console.info("[rl-tabswitch]", tab.id, `${Math.round(performance.now() - switchTiming.current.at)}ms`); switchTiming.current = null; }
          setLiveVersion((v) => v + 1);
        })
        .catch((e) => {
          creatingRef.current.delete(tab.id);
          if (nativeMountedRef.current) setLiveVersion((v) => v + 1);
          if (!nativeMountedRef.current || epoch !== nativeEpochRef.current || !tabsRef.current.some((t) => t.id === tab.id)) return;
          console.error("browser tab webview failed to create", e);
          // Don't strand the tab blank: a failed create is usually the prior
          // webview for this label still tearing down (suspend's close() is
          // async). Retry a bounded number of times by re-running reconcile;
          // selectTab/navigate also re-trigger this on user action. Give up
          // after a few tries so a genuinely broken tab can't spin forever.
          const n = (wakeAttemptsRef.current.get(tab.id) ?? 0) + 1;
          wakeAttemptsRef.current.set(tab.id, n);
          if (n <= 3 && tabsRef.current.some((t) => t.id === tab.id)) {
            retryAtRef.current.set(tab.id, Date.now() + 300 * n);
            window.setTimeout(() => { if (nativeMountedRef.current && epoch === nativeEpochRef.current) setLiveVersion((v) => v + 1); }, 300 * n);
          } else { retryAtRef.current.set(tab.id, Infinity); setPageErrors((prev) => ({ ...prev, [tab.id]: "This page could not be opened. Check the address or try again." })); }
        });
    }
    for (const [id, view] of [...wvMapRef.current]) {
      if (!tabs.some((t) => t.id === id)) {
        geometry.hide(id, view);
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
  const heldLiveRef = useRef(new Set<string>());
  const enforceLiveBudget = useCallback(() => {
    const active = activeIdRef.current;
    // Every visible tile stays live unconditionally; recency tops up the rest.
    const budget = Math.min(MAX_MOSAIC_TILES, Math.max(MAX_LIVE_WEBVIEWS, tileIdsRef.current.length));
    // A tab that refused suspension (a PDF, a blob: page, media playing)
    // stays live and takes a slot, like a pinned tab, until it would allow it.
    const held = heldLiveRef.current;
    for (const id of held) if (!wvMapRef.current.has(id)) held.delete(id);
    const keep = new Set([...tileIdsRef.current, active, ...held]);
    for (const id of mruRef.current) {
      if (keep.size >= budget) break;
      keep.add(id);
    }
    for (const [id] of [...wvMapRef.current]) {
      if (keep.has(id) && !held.has(id)) continue;
      void invoke<boolean>("browser_can_suspend", { label: `browser-${id}` })
        .then((ok) => {
          if (!ok) { held.add(id); return; }
          held.delete(id);
          // Bail if it is wanted again, became active, or is already gone.
          if (keep.has(id) || tileIdsRef.current.includes(id) || id === activeIdRef.current || !wvMapRef.current.has(id)) {
            return;
          }
          void invoke("browser_suspend", { label: `browser-${id}` }).catch(() => {});
        })
        .catch(() => {});
    }
  }, []);

  // On tab switch: snapshot the tab we're leaving, hide the others, reflect the
  // active URL in the bar, show the new one.
  const prevActiveIdRef = useRef(activeId);
  const activeSinceRef = useRef(performance.now());
  useEffect(() => {
    const leaving = prevActiveIdRef.current, lingered = performance.now() - activeSinceRef.current >= 1000;
    prevActiveIdRef.current = activeId; activeSinceRef.current = performance.now();
    for (const [id, view] of wvMapRef.current) if (!tileIdsRef.current.includes(id)) geometry.hide(id, view);
    const tab = tabsRef.current.find(tab => tab.id === activeId);
    if (tab) setAddr(tab.url === NEWTAB ? "" : tab.url);
    syncBounds();
    let shownFrame = 0;
    if (tab && (tab.url === NEWTAB || wvMapRef.current.has(activeId))) shownFrame = requestAnimationFrame(() => {
      if (switchTiming.current?.id !== activeId || activeIdRef.current !== activeId) return;
      console.info("[rl-tabswitch]", activeId, `${Math.round(performance.now() - switchTiming.current.at)}ms`);
      switchTiming.current = null;
    });
    const timer = window.setTimeout(() => {
      ensureLive(activeId); touchMru(activeId); enforceLiveBudget();
      if (tab) updateTileLayoutRef.current({ focused: tab.browseId, ...(tileLayout.maximized && tileLayout.maximized !== tab.browseId ? { maximized: null } : {}) });
      if (lingered && leaving !== activeId && wvMapRef.current.has(leaving)) {
        const snapshot = () => scheduleCacheRef.current(leaving, 0);
        if (window.requestIdleCallback) window.requestIdleCallback(snapshot, { timeout: 1000 }); else window.setTimeout(snapshot, 0);
      }
      if (!tab || tab.url === NEWTAB || !wvMapRef.current.has(activeId)) return;
      const handle = wvMapRef.current.get(activeId);
      let timeout = 0;
      void Promise.race([
        invoke<string>("browser_eval_result", { label: tab.label, script: "JSON.stringify({ready:document.readyState,children:document.body?document.body.children.length:0})" }),
        new Promise<string>((_, reject) => { timeout = window.setTimeout(() => reject(new Error("Page probe timed out")), 1500); }),
      ]).then(raw => { const state = JSON.parse(raw); if (/^https?:/.test(tab.url) && !state.children) throw new Error("Empty page"); })
        .catch(() => { if (wvMapRef.current.get(activeId) !== handle || activeIdRef.current !== activeId) return; void invoke("browser_close", { label: tab.label }).finally(() => forgetNativeRef.current(activeId, true)); })
        .finally(() => window.clearTimeout(timeout));
    }, 120);
    return () => { window.clearTimeout(timer); cancelAnimationFrame(shownFrame); };
  }, [activeId, ensureLive, touchMru, enforceLiveBudget, syncBounds]);

  // (Visibility reflows are handled by the active-tracking effect below, which
  // keys on effectiveVisible and `layoutKey`.)

  // Observe the slot for size changes. It used to re-attach on `chatOpen`
  // because opening the discussion re-parented this div into a SplitPane — a
  // new DOM node the old observer no longer watched. The panels live in the
  // app's dock now, so the slot is the same element for the pane's whole life
  // and one observer covers it.
  useEffect(() => {
    const el = slotRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => { setStageWidth(el.getBoundingClientRect().width); scheduleSync(); });
    ro.observe(el);
    return () => ro.disconnect();
  }, [scheduleSync, chatOpen, dockSlot, browserFullscreen]);

  useEffect(() => {
    const timer = window.setTimeout(() => { for (const id of tileIdsRef.current) ensureLive(id); scheduleSync(); }, 120);
    scheduleSync();
    return () => window.clearTimeout(timer);
  }, [tileGeometryKey, effectiveVisible, ensureLive, scheduleSync]);

  useEffect(() => {
    void invoke("browser_protect_tabs", { labels: effectiveVisible ? tileIdsRef.current.map((id) => `browser-${id}`) : [] }).catch(() => {});
    return () => { void invoke("browser_protect_tabs", { labels: [] }).catch(() => {}); };
  }, [tileGeometryKey, effectiveVisible]);

  // The JS webview API surfaces no navigation events, so poll the active tab's
  // real URL to keep the address bar and tab title honest as the page navigates
  // (link clicks, redirects, search submits). Paused while the app is
  // backgrounded.
  usePoll(
    async () => {
      // Skip while hidden under an overlay — nothing is visible to keep in
      // sync, so don't pay the IPC + re-render cost.
      if (!visibleRef.current) return;
      const id = activeIdRef.current;
      if (!wvMapRef.current.has(id)) return;
      const requestedUrl = tabsRef.current.find((tab) => tab.id === id)?.url;
      try {
        const url = await invoke<string>("browser_url", {
          label: `browser-${id}`,
        });
        if (!url || url === "about:blank") return;
        // A blob:/data:/file: document is shown, never persisted: the tab keeps
        // its last http(s) address as the one a restart reopens.
        if (!isDurableTabUrl(url)) {
          if (id === activeIdRef.current && !addrFocusedRef.current) setAddr(url);
          return;
        }
        // A page event or explicit navigation may have overtaken this poll.
        if (tabsRef.current.find((tab) => tab.id === id)?.url !== requestedUrl) return;
        const current = tabsRef.current.find((t) => t.id === id);
        const changed = current?.url !== url;
        // The favicon is a script evaluation in the page: read it when the
        // page moves, or while the tab has none, never on every tick.
        if (changed || !current?.favicon) {
          const favicon = await invoke<string>("browser_eval_result", { label: `browser-${id}`, script: "String(document.querySelector('link[rel~=icon]')?.href || new URL('/favicon.ico',location.href))" }).catch(() => "");
          if (/^https?:/.test(favicon)) setTabs(prev => prev.map(tab => tab.id === id && tab.favicon !== favicon ? { ...tab, favicon } : tab));
        }
        // Only re-key state when the URL actually moved — `ts.map` would
        // otherwise allocate a fresh array every poll tick (once a second) and
        // re-render the whole pane + discussion, which churns the chat DOM and
        // makes text selection in a reply flaky. Return `ts` to bail out.
        if (changed) {
          setTabs((ts) => {
            const i = ts.findIndex((t) => t.id === id);
            if (i === -1 || ts[i].url === url) return ts;
            const next = ts.slice();
            next[i] = { ...next[i], url, title: browserPageTitle(next[i], url) };
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
    },
    5000,
    { pauseWhenHidden: true, leading: false },
  );

  // Poll the active tab's page signals (set by injected shims on the TOP frame):
  //  • `__redline_fs` — the in-window fullscreen flag (watch-pages + the embed
  //    handshake), which drives the fullscreen layout.
  //  • `__redline_newtabs` — a queue of URLs the new-tab shim captured from
  //    `target="_blank"` links, `window.open`, and cmd/middle-clicks. WebKit
  //    drops those requests on the floor for these child webviews (wry's UI
  //    delegate has no new-window handler), so the shim intercepts them and we
  //    open a real Redline tab here instead. Draining is idempotent (the shim
  //    hands back and clears the queue in one eval).
  //  • `__redline_selections` — the same shape, for taps on the in-page
  //    highlight action bar. Read-and-cleared in the same eval, so a dropped
  //    poll cycle loses nothing and a slow cycle can't double-dispatch.
  // Reuses the proven string-returning eval path — no new native plumbing.
  // Native page events deliver promptly; this is a low-frequency recovery
  // poll, paused while the app is backgrounded.
  usePoll(
    async () => {
      // A temporary overlay does not end a video session.
      if (!visibleRef.current) return null;
      const id = activeIdRef.current;
      if (!wvMapRef.current.has(id)) return null;
      const raw = await invoke<string>("browser_eval_result", {
        label: `browser-${id}`,
        script:
          '(function(){try{var q=window.__redline_newtabs||[];window.__redline_newtabs=[];' +
          'var s=window.__redline_selections||[];window.__redline_selections=[];' +
          'return JSON.stringify({fs:!!window.__redline_fs,tabs:q,sel:s})}catch(e){return "{}"}})()',
      });
      return { id, raw };
    },
    5000,
    {
      pauseWhenHidden: true,
      leading: false,
      // Acted on only while the pane is mounted (a drain that lands after
      // unmount is dropped, as it always was). A throw — the webview gone
      // mid-poll — is the poll's to swallow.
      onResult: (drain) => {
        if (!drain || drain.id !== activeIdRef.current) return;
        const { id, raw } = drain;
        let sig: { fs?: boolean; tabs?: unknown; sel?: unknown } = {};
        try {
          sig = JSON.parse(raw || "{}");
        } catch {
          /* malformed — treat as no signal */
        }
        if (typeof sig.fs === "boolean") videoFsRef.current.dispatch({ type: "page", tabId: id, on: sig.fs });
        if (Array.isArray(sig.tabs)) {
          for (const u of sig.tabs) {
            if (typeof u === "string" && /^https?:/i.test(u)) {
              openTabRef.current(u);
            }
          }
        }
        // The offset keeps the seed nonces distinct when a single drain carries
        // more than one tap — same millisecond, different seeds.
        const now = Date.now();
        parseSelectionEvents(sig.sel).forEach((ev, i) => {
          dispatchSelectionRef.current(ev, now + i);
        });
      },
    },
  );

  const forgetNative = useCallback((id: string, recreate: boolean) => {
    const view = wvMapRef.current.get(id); if (view) geometry.hide(id, view);
    wvMapRef.current.delete(id); liveIntentRef.current.delete(id); creatingRef.current.delete(id);
    eventPagesRef.current.delete(id); wakeAttemptsRef.current.delete(id); retryAtRef.current.delete(id);
    if (recreate) ensureLive(id); else setLiveVersion(value => value + 1);
  }, [geometry, ensureLive]);
  forgetNativeRef.current = forgetNative;
  useEffect(() => {
    const subscription = listen<{ label: string }>("browser-tab-suspended", ({ payload }) => {
      const tab = tabsRef.current.find(tab => tab.label === payload.label);
      if (tab) forgetNative(tab.id, visibleRef.current && tileIdsRef.current.includes(tab.id));
    });
    return () => { void subscription.then(stop => stop()); };
  }, [forgetNative]);
  useEffect(() => {
    const subscription = listen<{ label: string; kind: string; url?: string; title?: string; fullscreen?: boolean; value?: unknown }>("browser-page-event", ({ payload: event }) => {
      const tab = tabsRef.current.find((t) => t.label === event.label);
      if (!tab) return;
      if (event.kind === "terminated" || event.kind === "dead") {
        const shown = visibleRef.current && tileIdsRef.current.includes(tab.id);
        if (shown) setReloading(prev => new Set(prev).add(tab.id));
        if (!shown || event.kind === "dead") {
          // Closing first prevents getByLabel from adopting the crashed process.
          void invoke("browser_close", { label: tab.label }).finally(() => forgetNative(tab.id, shown));
        }
        return;
      }
      eventPagesRef.current.add(tab.id);
      if (event.kind === "state" && event.url) {
        setReloading(prev => { if (!prev.has(tab.id)) return prev; const next = new Set(prev); next.delete(tab.id); return next; });
        // The transient document created before navigation isn't the tab's page.
        if (event.url === "about:blank") return;
        const url = event.url;
        setTabs((prev) => prev.map((t) => {
          if (t.id !== tab.id) return t;
          const title = browserPageTitle(t, url, event.title);
          return t.url !== url || t.title !== title ? { ...t, url, title } : t;
        }));
        if (tab.id === activeIdRef.current && !addrFocusedRef.current) setAddr(url);
        if (typeof event.fullscreen === "boolean") {
          videoFsRef.current.dispatch({ type: "page", tabId: tab.id, on: event.fullscreen });
          if (!surfaceActiveRef.current) videoFsRef.current.dispatch({ type: "surface", active: false });
          else if (event.fullscreen && tab.id !== activeIdRef.current) videoFsRef.current.dispatch({ type: "active", prev: tab.id, next: activeIdRef.current });
          else if (tab.url !== url && videoFsRef.current.state.tabId === tab.id) videoFsRef.current.dispatch({ type: "exit" });
        }
        if (tab.url !== url) { scheduleCacheRef.current(tab.id); applySiteAppearanceRef.current({ ...tab, url }); }
      } else if (event.kind === "interaction" || event.kind === "focus") {
        // A press in the page never reaches Redline's own document: say so, for
        // the footer pill's floating card, which closes on a press outside it.
        if (event.kind === "interaction" && (event.value === "pointerdown" || event.value === "touchstart") && visibleRef.current) window.dispatchEvent(new Event("redline:page-press"));
        if (visibleRef.current && tileIdsRef.current.includes(tab.id) && tab.id !== activeIdRef.current) selectTabRef.current(tab.id);
      } else if (event.kind === "tabs" && typeof event.value === "string" && /^https?:/.test(event.value)) openTabRef.current(event.value);
      else if (event.kind === "selection" && visibleRef.current) parseSelectionEvents([event.value]).forEach((selection, i) => dispatchSelectionRef.current(selection, Date.now() + i));
      else if (event.kind === "shortcut" && tileIdsRef.current.includes(tab.id) && visibleRef.current) {
        if (event.value === "location") focusAddressRef.current();
        else if (event.value === "toggle-monochat") window.dispatchEvent(new Event("redline:toggle-monochat"));
        // The flow shell's ⌘B / ⌘⌥B; nothing listens in the classic shell.
        else if (event.value === "toggle-sidebar" || event.value === "toggle-plan-panel") window.dispatchEvent(new Event(`redline:${event.value}`));
        else if (event.value === "open-front-door") window.dispatchEvent(new Event("redline:open-front-door"));
        else if (event.value === "exit-focus") { if (videoFsRef.current.stage !== "off") videoFsRef.current.dispatch({ type: "exit" }); else { restoreTilesRef.current(); } }
        else if (event.value === "toggle-video-screen") {
          if (videoFsRef.current.stage === "browser") void videoFsRef.current.requestScreen();
          else if (videoFsRef.current.stage === "screen") void Window.getCurrent().setFullscreen(false).catch((error) => setWorkspaceError(String(error)));
        }
        // ⌃Tab / ⌃⇧Tab from the page: the browser's own pages.
        else if (event.value === "next-page" || event.value === "previous-page") {
          const id = shortcutTabId(tabsRef.current.map((page) => page.id), tab.id, event.value === "next-page" ? "next-tab" : "previous-tab");
          if (id) selectTabRef.current(id);
        }
        // ⌘⌥← / ⌘⌥→ from the page: the WORKBENCH's tabs, which App owns.
        // (⌘T, ⌘W and ⌘⇧[ / ⌘⇧] are native menu items: the menu takes them
        // before the page sees them, so no page ever posts them.)
        else if (event.value === "next-tab" || event.value === "previous-tab") {
          window.dispatchEvent(new CustomEvent("redline:workbench-tab-cycle", { detail: event.value === "next-tab" ? 1 : -1 }));
        }
      }
      else if (event.kind === "inspect" && event.value && typeof event.value === "object") {
        if (!pickerRef.current.accept(event.label)) return;
        dispatchChat({ type: "inspect", tabId: tab.id });
        setChatSeed({ ...inspectorSeed({ ...(event.value as Record<string, unknown>), tabId: tab.id, browseId: tab.browseId }), source: { kind: "element" } });
        setChatFor(tab.browseId, { open: true, pill: "page" });
      } else if (event.kind === "inspect-error" && pickerRef.current.accept(event.label)) setWorkspaceError(PICKING_ERROR);
    });
    return () => { void subscription.then((unlisten) => unlisten()).catch(() => {}); };
  }, []);

  useEffect(() => {
    const subscription = listen<{ workspaceId: string; revision: number; tab: { browseId: string; id?: string; url: string; title?: string } }>("browser-workspace-tab-added", ({ payload }) => {
      noteWorkspaceRevision(payload.workspaceId, payload.revision);
      if (payload.workspaceId !== workspaceKeyRef.current || !payload.tab?.browseId) return;
      const [tab] = restoreBrowserTabs([payload.tab], newBrowseId, initialBrowserTitle);
      if (!tab) return;
      setTabs((prev) => prev.some((page) => page.browseId === tab.browseId) ? prev : [...prev, tab]);
    });
    return () => { void subscription.then((unlisten) => unlisten()).catch(() => {}); };
  }, []);

  // Stage two uses a native window rectangle; stage one follows the DOM slot.
  useEffect(() => {
    scheduleSync();
  }, [videoFs.stage, scheduleSync]);

  // A surrounding App pane toggled (comment pane opened/closed, sidebar
  // collapsed, doc-split flipped, …). These reflow the slot WITHOUT a divider
  // drag, and the OS-composited webview — which always paints ON TOP of the
  // React DOM — is left stranded at its old rect: a gap of blank space when the
  // slot grows (closing the sidecar), or the page spilling OVER the appearing
  // pane when the slot shrinks (opening the sidecar).
  //
  // Any no-drag slot reflow — a surrounding App pane toggling: comment pane,
  // sidebar, doc-split, and (since the four panels moved out to it) the
  // conversation dock opening, closing or being dragged. All of them arrive
  // through `layoutKey`. The OS-composited webview, which always paints ON TOP
  // of the React DOM, must follow the slot: a gap when it grows, the page
  // spilling over the dock when it shrinks.
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
    let raf = 0;
    let stableFrames = 0;
    let previousMeasurement = "";
    let frames = 0;
    const tick = () => {
      // Hidden (overlay up, or mid-divider-drag): hide once and stop — there's
      // nothing to track, and spinning would just churn. Becoming visible again
      // re-runs this effect (effectiveVisible changed) and resumes tracking.
      if (!visibleRef.current) {
        syncBounds();
        return;
      }
      const measured = JSON.stringify(measureTiles().map(({ id, rect }) => [id, rect]));
      syncBounds();
      const unchanged = measured === previousMeasurement;
      previousMeasurement = measured;
      stableFrames = unchanged ? stableFrames + 1 : 0;
      // Stop once the rect has held for ~5 frames, or after ~40 frames (~0.6s) —
      // long enough to outlast any pane open/close/resize reflow.
      if (stableFrames < 5 && frames++ < 40) {
        raf = requestAnimationFrame(tick);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [layoutKey, effectiveVisible, syncBounds]);

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
      const epoch = nativeEpochRef.current;
      const all = await Webview.getAll().catch(() => []);
      if (!nativeMountedRef.current || nativeEpochRef.current !== epoch) return;
      const ours = new Set(tabsRef.current.map((t) => t.label));
      for (const wv of all) {
        if (!wv.label.startsWith("browser-")) continue;
        if (!ours.has(wv.label)) {
          // Stray from a prior instance whose tab set differs — free it.
          geometry.hide(wv.label.slice("browser-".length), wv);
        } else if (!tileIdsRef.current.some((id) => `browser-${id}` === wv.label)) {
          // Ours, but not the active tab. On a remount our wvMapRef starts
          // empty, so the previously-active webview from the old instance is
          // untracked and would stay SHOWN at its stale (full-column) bounds,
          // painting over the document. Only the active tab is ever shown, so
          // hide every other live webview now; syncBounds shows the active one.
          geometry.hide(wv.label.slice("browser-".length), wv);
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
      void videoFsRef.current.observeWindow();
      scheduleSync();
      trailing.forEach(clearTimeout);
      trailing.length = 0;
      trailing.push(
        window.setTimeout(scheduleSync, 250),
        window.setTimeout(scheduleSync, 600),
      );
    };
    let unResized: (() => void) | undefined;
    let resizeSubscriptionCancelled = false;
    void Window.getCurrent()
      .onResized(onNativeResize)
      .then((un) => {
        if (resizeSubscriptionCancelled) un(); else unResized = un;
      })
      .catch(() => {});

    return () => {
      // Clear the guard too: a cancelled frame left in it makes scheduleSync a
      // permanent no-op after a StrictMode remount (rail collapse, resizes).
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
      window.removeEventListener("resize", onWin);
      trailing.forEach(clearTimeout);
      resizeSubscriptionCancelled = true;
      unResized?.();
      const map = wvMapRef.current;
      pendingTeardown = window.setTimeout(() => {
        pendingTeardown = 0;
        for (const id of map.keys()) closeWebview(`browser-${id}`);
        map.clear();
      }, TEARDOWN_GRACE_MS);
    };
  }, [scheduleSync]);

  // Foreground a tab, and tell the chat which gesture did it: the event, not
  // this function, decides whether the conversation follows the page.
  const foregroundTab = (id: string, event: ChatEvent) => {
    // Selecting a suspended tab wakes it: ensure it has a live webview (recreate
    // if its prior one died or never materialized), and bump its recency.
    switchTiming.current = { id, at: performance.now() };
    setActiveId(id);
    if (id === activeIdRef.current) ensureLive(id);
    return dispatchChat(event);
  };
  // A tab click, a tile focus, a keyboard next/previous tab: a full switch
  // that re-couples page and conversation (BC-5).
  const selectTab = (id: string) => {
    // A drag just ended on this tab — that's a reorder, not a selection.
    if (suppressTabClickRef.current) {
      suppressTabClickRef.current = false;
      return;
    }
    foregroundTab(id, { type: "user-select-tab", tabId: id });
  };

  const tabDragCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => tabDragCleanupRef.current?.(), []);
  const startTabDrag = (e: React.PointerEvent, id: string) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
    tabDragCleanupRef.current?.();
    tabDragCleanupRef.current = startTabPointerDrag(e.nativeEvent, e.currentTarget as HTMLElement, {
      axis: "y",
      onDragging: setTabDragging,
      onDrop: (overId, tileIndex) => flushSync(() => {
        suppressTabClickRef.current = true;
        window.setTimeout(() => { suppressTabClickRef.current = false; }, 0);
        const tab = tabsRef.current.find(page => page.id === id);
        if (tileIndex !== null && tab) {
          updateTileLayout(assignVisibleTile(tileLayout, visibleBrowseIds, tileIndex, tab.browseId));
          setActiveId(tab.id); dispatchChat({ type: "user-select-tab", tabId: tab.id });
        } else if (overId && overId !== id) {
          if (organized && tab) { const target = tabsRef.current.find(page => page.id === overId); const group = groups.find(group => group.browseIds.includes(target?.browseId ?? "")); if (group) setGroups(moveTabToGroup(groups, tab.browseId, group.id)); }
          else setTabs(ts => reorderTabs(ts, id, overId));
        }
      }),
    });
  };

  /** Returns the browse ID of the tab opened or foregrounded. `via` is the
   *  gesture, for the chat: the user's own open moves the conversation onto
   *  the page; an agent's brings the page forward while the conversation
   *  stays anchored to the tab it started on; a link clicked in a reply does
   *  the same, unless that page is already open in a tab, which it selects;
   *  a plan Search opens a fresh tab with its own chat (BC-5, BC-6). */
  const openTab = (
    url: string = HOME,
    { via = "user" }: { via?: "user" | "agent" | "source" | "plan-search" } = {},
  ): string | null => {
    const opened = (tab: Tab, existing: boolean): ChatEvent =>
      via === "agent" ? { type: "agent-open-tab", tab }
      : via === "source" ? { type: "open-source", tab, existing }
      : via === "plan-search" ? { type: "plan-search-opened", tab }
      : { type: "user-open-tab", tab };
    // Opening an already-open URL foregrounds that tab instead of stacking a
    // duplicate — "Open" on a Localhost card (and any replayed request) would
    // otherwise accumulate tabs. `sameTabUrl`, not `===`: the poll below
    // rewrites `t.url` to the webview's canonical URL, so a tab opened at
    // `http://localhost:3000` is holding `http://localhost:3000/dashboard` by
    // the time you click the card again. Blank tabs are exempt: "+" on HOME is
    // an intentional second empty tab. So is a plan Search: it wants a tab
    // (and a chat) of its own even when the same page is open.
    if (url !== HOME && url !== NEWTAB && via !== "plan-search") {
      const existing = tabsRef.current.find((t) => sameTabUrl(t.url, url));
      if (existing) {
        ensureLive(existing.id);
        touchMru(existing.id);
        setActiveId(existing.id);
        updateTileLayout({ focused: existing.browseId, maximized: null });
        dispatchChat(opened(existing, true));
        return existing.browseId;
      }
    }
    if (tabsRef.current.length >= MAX_TABS) return null;
    const browseId = newBrowseId();
    const id = canonicalTabId(browseId);
    const tab: Tab = {
      id,
      label: `browser-${id}`,
      url,
      title: initialBrowserTitle(url),
      browseId,
    };
    markLive(id);
    touchMru(id);
    setTabs((ts) => [...ts, tab]);
    setActiveId(id);
    updateTileLayout({ focused: browseId, maximized: null });
    dispatchChat(opened(tab, false));
    if (url === NEWTAB) window.setTimeout(() => focusAddressRef.current(), 0);
    return browseId;
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
    // Closing the anchored tab re-anchors the conversation to the page on
    // screen, so the chat never points at a dead thread (BC-5).
    dispatchChat({ type: "close-tab", tabId: id });
    explicitlyClosedRef.current.add(id);
    const closedBrowseId = tabsRef.current.find((tab) => tab.id === id)?.browseId;
    updateTileLayout({ tiles: tileLayout.tiles.filter((bid) => bid !== closedBrowseId),
      maximized: tileLayout.maximized === closedBrowseId ? null : tileLayout.maximized,
      focused: tileLayout.focused === closedBrowseId ? remaining[0]?.browseId ?? null : tileLayout.focused });
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

  // Stable native labels derive from the durable conversation ID, so separate
  // workspaces cannot collide on t0/t1 or change identity after a restart.
  const rebuildTabs = (descs: { id?: string | null; url: string; title?: string; browseId?: string | null }[]): Tab[] => {
    const built = restoreBrowserTabs(descs, newBrowseId, initialBrowserTitle);
    return built.length ? built : [freshHomeTab()];
  };

  // Flush the current tabs to their bucket (mission row or `TABS_KEY`). Callers
  // run this before leaving a workspace so nothing is lost on switch.
  const saveCurrentWorkspace = async () => {
    const descs = tabsRef.current.map(descriptorOf);
    const mid = activeMissionIdRef.current;
    await saveBrowserWorkspace(workspaceKeyRef.current, { tabs: descs, layout: tileLayout, groups, organized });
    if (mid) {
      await mission.setMissionTabs(mid, descs);
    } else if (workspaceKeyRef.current === "regular") {
      try {
        localStorage.setItem(TABS_KEY, JSON.stringify(descs));
      } catch {
        /* ignore */
      }
    }
  };

  // Tear down every live native webview (the swap rebuilds with new ids).
  const teardownLiveWebviews = () => {
    nativeEpochRef.current++;
    geometry.hideAll();
    wvMapRef.current.clear();
    setPageErrors({});
    // In-flight creations settle against their stable browseId and hide if
    // their workspace has left. The native manager owns inactive-page eviction.
  };

  // PURE load (callers save the outgoing workspace first): tear down the current
  // webviews, materialize the target's tabs, and flip the active mission.
  const workspaceSwapEpoch = useRef(0);
  const swapWorkspace = async (
    target: { kind: "mission"; id: string } | { kind: "mosaic"; id: string } | { kind: "regular" },
  ) => {
    const epoch = ++workspaceSwapEpoch.current;
    let newSet: Tab[];
    const destinationId = target.kind === "regular" ? "regular" : target.id;
    let destinationLayout: BrowserLayout;
    let definition: Mosaic | null = null;
    try {
      const savedWorkspace = await loadBrowserWorkspace(destinationId);
      if (epoch !== workspaceSwapEpoch.current) throw new Error("A newer workspace switch replaced this request");
      if (savedWorkspace?.groups) setGroupsByWorkspace(prev => ({ ...prev, [destinationId]: savedWorkspace.groups! }));
      if (savedWorkspace?.organized !== undefined) setOrganizedByWorkspace(prev => ({ ...prev, [destinationId]: savedWorkspace.organized! }));
      if (target.kind === "mosaic") {
        // A mosaic opens from its definition: every cell at its saved address.
        definition = mosaicFromWorkspace(destinationId, savedWorkspace);
        if (!definition) throw new Error("This mosaic no longer exists.");
        newSet = rebuildTabs(mosaicTabs(definition));
        destinationLayout = mosaicLayout(definition);
      } else {
        newSet = savedWorkspace?.tabs.length ? rebuildTabs(savedWorkspace.tabs) : target.kind === "mission" ? rebuildTabs(await mission.getMissionTabs(target.id)) : loadTabs();
        destinationLayout = normalizeBrowserLayout(savedWorkspace?.layout ?? layoutsRef.current[destinationId] ?? layoutsRef.current.default);
      }
      if (destinationId === "regular" && !destinationLayout.focused && !destinationLayout.maximized) {
        let savedActive: string | null = null;
        try { savedActive = localStorage.getItem(ACTIVE_KEY); } catch { /* optional legacy focus */ }
        destinationLayout.focused = newSet.find((page) => page.id === savedActive)?.browseId ?? null;
      }
      if (epoch !== workspaceSwapEpoch.current) throw new Error("A newer workspace switch replaced this request");
    } catch (error) {
      if (epoch === workspaceSwapEpoch.current) setWorkspaceError(`The workspace could not be opened. Your current pages are still available. ${String(error)}`);
      throw error;
    }
    swappingRef.current = true;
    endRestore();
    if (missionTabsTimerRef.current) { window.clearTimeout(missionTabsTimerRef.current); missionTabsTimerRef.current = null; }
    teardownLiveWebviews();
    setLayouts((prev) => ({ ...prev, [destinationId]: destinationLayout }));
    setWorkspaceKey(destinationId);
    const active = focusedWorkspaceTab(newSet, destinationLayout)!;
    // Seed only the active tab live (mirror mount seeding); others lazy-wake.
    // A mosaic is the exception: every tile is on screen, so all of them.
    const mosaicTiles = definition ? newSet.filter((tab) => destinationLayout.tiles.includes(tab.browseId)).map((tab) => tab.id) : [];
    liveIntentRef.current = new Set([active.id, ...mosaicTiles]);
    mruRef.current = [active.id];
    homeNavigateRef.current = new Set(mosaicTiles);
    setActiveMosaic(definition);
    // The swap ends when THIS array commits — the `[tabs]` effect matches it
    // by identity and clears `swappingRef` there. Resetting synchronously
    // here re-enabled persistence before that effect ran, leaking the
    // swapped-in tabs into the outgoing bucket.
    swapCommitRef.current = newSet;
    setTabs(newSet);
    setActiveId(active.id);
    // Threads reattach by browseId; any flip is dropped and the mode decides
    // (BC-8), and the workspace's shared chat exists before it renders.
    dispatchChat({ type: "workspace-swapped", workspace: destinationId, tabs: newSet, activeId: active.id });
    setAddr(active.url);
    setLiveVersion((v) => v + 1);
    if (target.kind === "mission") mission.resumeMission(target.id);
    else mission.closeMission();
    if (target.kind !== "mosaic") mosaicReturnRef.current = "regular";
    // The tab that is now active. Returned rather than read back through
    // `activeBrowseIdRef`: the setState calls above haven't committed when this
    // returns, so a caller wanting to open the mission panel on the swapped-in
    // workspace would otherwise write to the OUTGOING tab's key.
    return active.browseId;
  };

  // Start a new mission. From regular browsing the current tabs carry in (and
  // regular resets to a clean slate); from inside a mission, that one is saved
  // and the new one opens fresh.
  const startNewMission = async (title: string, goal: string) => {
    const fromRegular = workspaceKeyRef.current === "regular";
    const currentDescs = tabsRef.current.map(descriptorOf);
    await saveCurrentWorkspace();
    const m = await mission.startMission(title, goal, fromRegular ? currentDescs : [], projectDir); // sets active = m
    if (!m) return;
    if (fromRegular) {
      // The shared chat goes with the tabs; regular browsing starts fresh (BC-4).
      dispatchChat({ type: "mission-started-from-regular", missionId: m.missionId });
      setWorkspaceKey(m.missionId);
      setLayouts((prev) => ({ ...prev, [m.missionId]: tileLayout }));
      await saveBrowserWorkspace(m.missionId, { tabs: currentDescs, layout: tileLayout });
      await mission.setMissionTabs(m.missionId, currentDescs);
      const regularHome = freshHomeTab();
      await saveBrowserWorkspace("regular", { tabs: [descriptorOf(regularHome)], layout: normalizeBrowserLayout(layoutsRef.current.default) });
      try {
        localStorage.setItem(
          TABS_KEY,
          JSON.stringify([descriptorOf(regularHome)]),
        );
      } catch {
        /* ignore */
      }
      // No swap — the current tabs/webviews stay; they're now the mission's.
      setChatHere({ open: true, pill: "mission" });
    } else {
      // The swap hands back the tab that becomes active; `activeBrowseIdRef`
      // still points at the outgoing one here.
      const landed = await swapWorkspace({ kind: "mission", id: m.missionId });
      setChatFor(landed, { open: true, pill: "mission" });
    }
  };

  const switchToMission = async (id: string) => {
    if (id === activeMissionIdRef.current) {
      setChatHere({ open: true, pill: "mission" });
      return;
    }
    await saveCurrentWorkspace();
    const landed = await swapWorkspace({ kind: "mission", id });
    setChatFor(landed, { open: true, pill: "mission" });
  };

  const exitMission = async () => {
    await saveCurrentWorkspace();
    await swapWorkspace({ kind: "regular" });
  };

  // The header's "Tab chat" / "Shared chat": show the other kind of chat on
  // the tab you're looking at, until you switch away (BC-3).
  const toggleTabChat = () => {
    dispatchChat({ type: "toggle-tab-chat" });
    setChatHere({ open: true, pill: "page" });
  };
  const toggleLinkedMode = () => {
    dispatchChat({ type: "toggle-linked-mode" });
    setChatHere({ open: true, pill: "page" });
  };
  // A link the user clicks in a page-chat reply is a source: it opens beside
  // the conversation, which stays where it is (BC-5).
  const openSource = (url: string) => openTab(url, { via: "source" });

  const conversationEventRef = useRef<(event: Event) => void>(() => {});
  conversationEventRef.current = (event) => {
    const detail = (event as CustomEvent<{ conversationKind?: string; conversationId?: string }>).detail;
    if (!detail?.conversationId || !/^[a-zA-Z0-9_-]+$/.test(detail.conversationId)) return;
    if (detail.conversationKind === "browse") {
      // Back to that exact thread, whichever way linked mode leans (BC-7). A
      // thread that resolves to anything else is one whose tab has closed.
      const open: ChatEvent = { type: "open-conversation", browseId: detail.conversationId };
      const tab = tabsRef.current.find(item => item.browseId === detail.conversationId);
      const landed = tab ? foregroundTab(tab.id, open) : dispatchChat(open);
      if (resolveConversation(landed)?.browseId !== detail.conversationId) setWorkspaceError("This page conversation's tab is no longer open.");
      setChatHere({ open: true, pill: "page" });
    }
  };
  useEffect(() => {
    const conversation = (event: Event) => conversationEventRef.current(event);
    window.addEventListener("redline-open-conversation", conversation);
    return () => window.removeEventListener("redline-open-conversation", conversation);
  }, []);

  // --- Mosaics ---------------------------------------------------------------
  // A saved grid of pages. Opening one swaps the workspace exactly like a
  // mission; closing it returns to where you were.
  const refreshMosaics = () => {
    setMosaicError(null);
    // A read that failed says nothing about which mosaics exist.
    void listMosaics().then((list) => {
      setMosaicList(list);
      dispatchChat({ type: "workspaces-listed", missions: null, mosaics: list.map((m) => m.id) });
    }).catch((error) => { setMosaicList((prev) => prev ?? []); setMosaicError(`Saved mosaics could not be loaded. ${String(error)}`); });
  };
  const openMosaicManager = () => { setMosaicsOpen(true); refreshMosaics(); };
  const openMosaic = async (id: string) => {
    const from = workspaceKeyRef.current;
    // Reopening the open mosaic resets every tile to its saved address.
    if (from !== id) await saveCurrentWorkspace();
    await swapWorkspace({ kind: "mosaic", id });
    if (!isMosaicWorkspace(from)) mosaicReturnRef.current = from;
  };
  const leaveMosaic = async (save = true) => {
    const back = mosaicReturnRef.current;
    if (save) await saveCurrentWorkspace();
    if (back !== "regular" && mission.missions.some((item) => item.missionId === back)) await swapWorkspace({ kind: "mission", id: back });
    else await swapWorkspace({ kind: "regular" });
  };
  const editMosaic = async (id: string) => {
    const previous = await loadMosaic(id);
    if (!previous) throw new Error("This mosaic no longer exists.");
    setMosaicsOpen(false);
    setMosaicEdit({ previous, draft: { id, name: previous.name, grid: previous.grid, entries: previous.cells.map((cell) => ({ url: cell.url, label: cell.label ?? "" })) } });
  };
  const newMosaic = (fromCurrentPages: boolean) => {
    const pages = fromCurrentPages ? tabsRef.current.filter((tab) => /^https?:\/\//i.test(tab.url)).slice(0, MAX_MOSAIC_TILES) : [];
    setMosaicsOpen(false);
    setMosaicEdit({ previous: null, draft: { id: mosaicWorkspaceId(newBrowseId()), name: "", grid: pages.length ? gridFor(pages.length) : { rows: 2, cols: 2 }, entries: pages.map((tab) => ({ url: tab.url, label: "" })) } });
  };
  const saveMosaicEdit = async (next: Mosaic, isNew: boolean) => {
    await saveMosaic(next);
    setMosaicEdit(null);
    // A new mosaic opens straight away; an edit of the open one reloads it.
    if (isNew || next.id === workspaceKeyRef.current) void openMosaic(next.id).catch((error) => setWorkspaceError(String(error)));
    else openMosaicManager();
  };
  const deleteMosaicFlow = async (id: string) => {
    // Leave it first, without saving — its pages are being discarded.
    if (id === workspaceKeyRef.current) await leaveMosaic(false);
    await deleteMosaic(id);
    if (startupMosaic === id) setStartupMosaic(null);
    setLayouts((prev) => { if (!(id in prev)) return prev; const next = { ...prev }; delete next[id]; return next; });
    refreshMosaics();
  };

  const deleteMissionFlow = async (id: string) => {
    // Leave the mission first (without saving — its tabs are being discarded).
    if (id === activeMissionIdRef.current) await swapWorkspace({ kind: "regular" });
    await mission.deleteMission(id);
  };

  // On mount, if a mission was active last session, reopen its tab workspace
  // (once the mission list resolves). User-initiated activations happen after
  // this runs, so they don't double-swap. Until this resolves,
  // `missionRestorePendingRef` keeps the regular bucket's mounted tabs out of
  // persistence and the daemon mirror.
  useEffect(() => {
    if (initDoneRef.current) return;
    const pendingId = mission.activeMissionId;
    const startup = startupMosaicApplied ? null : startupMosaic;
    startupMosaicApplied = true;
    if (startup) {
      initDoneRef.current = true;
      // Closing the startup mosaic returns to the mission it displaced, if any.
      void swapWorkspace({ kind: "mosaic", id: startup })
        .then(() => { if (pendingId) mosaicReturnRef.current = pendingId; })
        .catch(() => swapWorkspace({ kind: "regular" }))
        .catch(endRestore);
      return;
    }
    if (!pendingId) {
      initDoneRef.current = true;
      void swapWorkspace({ kind: "regular" }).catch(endRestore);
      return;
    }
    if (mission.activeMission) {
      initDoneRef.current = true;
      // Keep regular pages out of mission persistence until the loaded
      // workspace commits. On failure, retain regular browsing and report it.
      void swapWorkspace({ kind: "mission", id: pendingId }).catch(() => {
        endRestore(); mission.closeMission();
      });
    } else if (mission.missionsLoaded || mission.error) {
      // The persisted mission no longer exists, or the list couldn't be read
      // — resolve to regular browsing rather than wedging the gate (which
      // would silence persistence and the daemon mirror, and hold every open
      // request, until a Retry). A failed list keeps its error and Retry on
      // screen; the mission itself is only closed, not lost.
      initDoneRef.current = true;
      endRestore();
      mission.closeMission();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mission.activeMissionId, mission.activeMission, mission.missionsLoaded, mission.error]);

  // Cmd+W (the native File ▸ Close item) closes the active page. A menu
  // accelerator fires even while the native webview has focus — which a JS
  // keydown listener can't catch — so the keystroke reaches the app as the
  // `menu-close-tab` Tauri event. App owns that event (⌘W closes from the
  // inside out: browser page → pane → tab) and dispatches this window event
  // when the pane in front is a browser pane. Kept in a ref so the
  // once-subscribed listener always calls the latest closeTab (which closes
  // the pane via onClose when the last page goes).
  const closeActiveRef = useRef<() => void>(() => {});
  closeActiveRef.current = () => closeTab(activeIdRef.current);
  useEffect(() => {
    const close = () => { if (surfaceActiveRef.current) closeActiveRef.current(); };
    window.addEventListener("redline:browser-close-page", close);
    return () => window.removeEventListener("redline:browser-close-page", close);
  }, []);
  // File ▸ Print… (⌘⌥P) prints the page in front; the page menu offers it too,
  // beside Save page/PDF, which saves through the tab's own cookies.
  const pageOutputRef = useRef<(command: "browser_print" | "browser_save_page") => void>(() => {});
  pageOutputRef.current = (command) => {
    const id = activeIdRef.current;
    if (!wvMapRef.current.has(id)) return;
    void invoke(command, { label: `browser-${id}` }).catch((e) => setWorkspaceError(String(e)));
  };
  useEffect(() => {
    const p = listen("menu-print", () => { if (surfaceActiveRef.current) pageOutputRef.current("browser_print"); });
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
        t.id === id ? { ...t, url, title: browserPageTitle(t, url) } : t,
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
        const view = wvMapRef.current.get(id); if (view) geometry.hide(id, view);
        wvMapRef.current.delete(id);
        ensureLive(id);
      },
    );
  };

  const evalActive = (script: string) => {
    const id = activeIdRef.current;
    void invoke("browser_eval", { label: `browser-${id}`, script }).catch(() => {
      if (nativeMountedRef.current && tabsRef.current.some((page) => page.id === id)) {
        setPageErrors((prev) => ({ ...prev, [id]: "This page stopped responding. Try opening it again." }));
      }
    });
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

  // The browse agent opens a tab by emitting `browse-open-tab` (it can't create
  // a native webview itself — BrowserPane owns the tab list). Foreground the new
  // tab but keep the discussion anchored to the conversation that opened it.
  // openTab is read through a ref so this listener subscribes once.
  const openTabRef = useRef(openTab);
  openTabRef.current = openTab;
  useEffect(() => {
    const p = listen<BrowseOpenTabEvent>("browse-open-tab", (e) => {
      const url = e.payload?.url;
      if (url) openTabRef.current(url, { via: "agent" });
    });
    return () => {
      void p.then((un) => un());
    };
  }, []);

  // An in-app request to open a URL (Localhost dashboard "Open"). Keyed on the
  // nonce so the same URL asked for twice opens twice, and so a re-render with
  // an unchanged request doesn't re-open anything. Consumption is reported
  // back so the owner clears the request — the nonce guard alone can't
  // survive a remount (the ref resets), and a stale request replayed on every
  // surface re-entry.
  const lastOpenNonceRef = useRef(0);
  const onOpenRequestConsumedRef = useRef(onOpenRequestConsumed);
  onOpenRequestConsumedRef.current = onOpenRequestConsumed;
  useEffect(() => {
    // Held until the mount-time restore has swapped its tabs in.
    if (!workspaceRestored || !openRequest || openRequest.nonce === lastOpenNonceRef.current) return;
    lastOpenNonceRef.current = openRequest.nonce;
    const existing = openRequest.focusBrowseId
      ? tabsRef.current.find((t) => t.browseId === openRequest.focusBrowseId)
      : undefined;
    // "View result" returns to the tab's OWN thread in either mode, which is
    // where its search's turn went; the Front Door's quiet reopen leaves the
    // choice to linked mode (BC-6).
    const reopen = (tabId: string): ChatEvent => ({ type: "reopen-tab", tabId, quiet: !!openRequest.quiet });
    let browseId: string | null;
    if (existing) {
      foregroundTab(existing.id, reopen(existing.id));
      browseId = existing.browseId;
    } else {
      // A plan Search opens a fresh tab whose own chat takes its turn.
      browseId = openTabRef.current(openRequest.url, { via: openRequest.chat ? "plan-search" : "user" });
      if (browseId && openRequest.focusBrowseId && !openRequest.quiet) dispatchChat(reopen(canonicalTabId(browseId)));
    }
    if (browseId && (openRequest.chat || (openRequest.focusBrowseId && !openRequest.quiet))) {
      if (openRequest.chat) {
        seedPageChat({ text: openRequest.chat.text, nonce: openRequest.nonce, source: { kind: "plan-search" } });
      }
      // By thread, not "here": the active-tab ref hasn't caught up with a
      // tab opened on this same tick.
      setChatFor(browseId, { open: true, pill: "page" });
    }
    onOpenRequestConsumedRef.current?.(browseId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openRequest, workspaceRestored]);

  // The browse agent switches the user into an existing tab by emitting
  // `browse-focus-tab`. It foregrounds the tab AND moves the conversation
  // into its thread — a full switch, exactly like clicking the tab (BC-5).
  const selectTabRef = useRef(selectTab);
  selectTabRef.current = selectTab;
  const foregroundTabRef = useRef(foregroundTab);
  foregroundTabRef.current = foregroundTab;
  useEffect(() => {
    const p = listen<BrowseFocusTabEvent>("browse-focus-tab", (e) => {
      const id = e.payload?.id;
      if (id && tabsRef.current.some((t) => t.id === id)) {
        foregroundTabRef.current(id, { type: "agent-focus-tab", tabId: id });
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

  const applySiteAppearance = (tab: Tab) => {
    const saved = siteAppearancesRef.current[siteKey(tab.url)];
    const profile = normalizeAppearance(saved);
    void invoke("browser_set_view", { label: tab.label, css: appearanceCss(profile), selectionActions: selectionActionsRef.current }).catch((e) => setWorkspaceError(String(e)));
    void invoke("browser_set_appearance", { label: tab.label, website: profile.website, zoom: profile.zoom }).catch((e) => setWorkspaceError(String(e)));
  };
  const applySiteAppearanceRef = useRef(applySiteAppearance);
  applySiteAppearanceRef.current = applySiteAppearance;
  useEffect(() => {
    for (const tab of tabsRef.current) if (wvMapRef.current.has(tab.id)) applySiteAppearanceRef.current(tab);
  }, [siteAppearances, selectionActions]);

  const reloadPageRef = useRef(() => {});
  reloadPageRef.current = () => { const tab = tabsRef.current.find((page) => page.id === activeIdRef.current); if (tab) { if (wvMapRef.current.has(tab.id) && !pageErrorsRef.current[tab.id]) evalActive("location.reload()"); else retryPage(tab.id); } };
  const focusAddressRef = useRef(() => {});
  focusAddressRef.current = () => {
    if (videoFsRef.current.stage !== "off") videoFsRef.current.dispatch({ type: "exit" });
    requestAnimationFrame(() => {
      const input = document.querySelector<HTMLInputElement>('[aria-label="Address or search"]');
      if (!input) return;
      // DOM focus alone can leave AppKit's Edit commands aimed at the native
      // page. Reclaim main as first responder, including repeated Cmd+L.
      void Webview.getCurrent().setFocus().catch(() => {});
      input.focus(); input.select();
    });
  };
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (!surfaceActiveRef.current || event.defaultPrevented) return;
      if (event.key === "Escape" && videoFsRef.current.stage !== "off") {
        if (videoFsRef.current.stage === "browser" && (event.target as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable]")) return;
        event.preventDefault(); event.stopImmediatePropagation(); videoFsRef.current.dispatch({ type: "exit" }); return;
      }
      if (event.metaKey && event.ctrlKey && event.key.toLowerCase() === "f" && videoFsRef.current.stage !== "off") {
        event.preventDefault();
        if (videoFsRef.current.stage === "browser") void videoFsRef.current.requestScreen();
        else void Window.getCurrent().setFullscreen(false).catch((error) => setWorkspaceError(String(error)));
        return;
      }
      // ⌘T is the workbench's door tab, and ⌘⌥←/→ and ⌘⇧[/] its tab cycle
      // (keymap.ts, App): none of them are the pane's any more.
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "r") { event.preventDefault(); reloadPageRef.current(); return; }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "l") { event.preventDefault(); focusAddressRef.current(); }
      // ⌃Tab / ⌃⇧Tab cycle the pane's pages (browser_signals.js posts the
      // same chord from inside a page as next-page / previous-page).
      if (event.ctrlKey && !event.metaKey && !event.altKey && event.key === "Tab") {
        event.preventDefault(); const next = shortcutTabId(tabsRef.current.map((tab) => tab.id), activeIdRef.current, event.shiftKey ? "previous-tab" : "next-tab"); if (next) selectTabRef.current(next);
      }
      if (event.key === "Escape") {
        pickerRef.current.cancel();
        setLayoutMenuOpen(false); setOverflowOpen(false);
        if (!(event.target as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable]")) restoreTilesRef.current();
      }
    };
    window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key);
  }, []);

  const retryPage = (id: string) => {
    setPageErrors((prev) => { const next = { ...prev }; delete next[id]; return next; });
    wakeAttemptsRef.current.delete(id);
    const view = wvMapRef.current.get(id);
    if (view) {
      geometry.hide(id, view);
      const tab = tabsRef.current.find((page) => page.id === id);
      if (tab) navigate(tab.url, id);
    }
    ensureLive(id);
  };
  const openResearch = () => setMissionMenuOpen(true);
  // The page chat is memoized. What it is handed keeps its identity across
  // the pane's own renders (a title, a dot, a layout tick) unless it really
  // changed: handlers through refs, the rail's cards by value. A handler
  // whose absence means something is passed or left out at the prop.
  const chatHandlers = useStableHandlers({
    toggleTabChat,
    toggleLinkedMode,
    research: openResearch,
    openLink: openSource,
    addToCart: addReplyToCart,
    close: () => setChatHere({ open: false }),
    seedConsumed: () => setChatSeed(null),
    // The element picker runs on a web page only; it attaches what is
    // picked as a chip (BC-15, BC-40).
    pickElement: () => void picker.start((tabs.find((t) => t.id === activeId) ?? tabs[0]).url),
    openTaskList: () => setChatHere({ open: true, pill: "cart" }),
    openMission: () => setChatHere({ open: true, pill: "mission" }),
    // The mission's synthesis is its orchestrator's turn: Synthesize opens
    // the Mission panel and starts it there.
    synthesize: () => {
      setSynthesizeAsked(true);
      setChatHere({ open: true, pill: "mission" });
    },
    addToMission: (body: string, targetBrowseId?: string | null) => {
      // The page the reply was about is the tab its turn targeted, which the
      // message keeps — in a shared chat that is not the tab on screen once
      // you have moved on, and never the tab the conversation is anchored to
      // (BC-24). A row from before that was kept falls back to the page on
      // screen. The pin is keyed by that page's tab, which is what a jump
      // and the page capture both read.
      const page = targetBrowseId
        ? tabs.find((t) => t.browseId === targetBrowseId)
        : tabs.find((t) => t.label === conversation?.targetLabel);
      // Returns whether the pin reached the DB, so the button can say "Pin
      // failed" instead of lying.
      return mission.addFinding({
        body,
        browseId: page?.browseId ?? targetBrowseId ?? null,
        sourceUrl: page?.url ?? null,
        sourceTitle: page?.title ?? null,
      });
    },
  });
  const chatTaskList = useStableValue({ nonce: listReloadKey, onOpen: chatHandlers.openTaskList });
  const chatMission = useStableValue(mission.activeMission ? {
    title: mission.activeMission.title,
    goal: mission.activeMission.goal,
    findings: mission.findings.length,
    onOpen: chatHandlers.openMission,
    onSynthesize: chatHandlers.synthesize,
  } : null);

  return (
    <div className="rb-workspace">
      {!browserFullscreen && <Suspense fallback={null}><BrowserTabRail tabs={tabs} activeId={activeId} acting={new Set(tabs.filter((tab) => pageActions.acting.has(`browser-${tab.id}`)).map((tab) => tab.id))} onSelect={selectTab} onCloseTab={closeTab} onNewTab={() => openTab(NEWTAB)} onTabDrag={startTabDrag} onResize={scheduleSync} tileBadges={tileBadges(visibleBrowseIds)} hoveredTileTab={hoveredTileTab} onHoverTile={setHoveredTileTab}
        groups={groups} organized={organized} organizing={organizing} onMode={value => setOrganizedByWorkspace(prev => ({ ...prev, [workspaceKey]: value }))} onOrganize={() => void organizeTabs()} onToggleGroup={id => setGroups(groups.map(group => group.id === id ? { ...group, collapsed: !group.collapsed } : group))}/></Suspense>}
      <div className="rb-workspace-pages">
      {!browserFullscreen && <BrowserChrome tabs={tabs} activeId={activeId} address={addr} onAddress={setAddr}
        onAddressFocus={(focused) => {
          addrFocusedRef.current = focused;
          if (focused) void Webview.getCurrent().setFocus().catch(() => {});
        }} onNavigate={() => navigate(addr)}
        onAddressCopyError={() => setWorkspaceError("Could not copy the selected address.")}
        onBack={() => evalActive("history.back()")} onForward={() => evalActive("history.forward()")}
        onReload={() => reloadPageRef.current()}
        onSelect={selectTab} onCloseTab={closeTab} onNewTab={() => openTab(NEWTAB)} onTabDrag={startTabDrag}
        tileBadges={tileBadges(visibleBrowseIds)} hoveredTileTab={hoveredTileTab} onHoverTile={setHoveredTileTab}
        chatOpen={chatOpen} onToggleChat={() => {
          if (chatOpen) setChatHere({ open: false });
          else setChatHere({ open: true, pill: chatHere.pill });
        }} split={tilePages.length > 1 || !!tileLayout.maximized} onArrange={() => setLayoutMenuOpen(true)}
        onMosaics={openMosaicManager}
        mosaic={isMosaicWorkspace(workspaceKey) ? { name: activeMosaic?.name ?? "Mosaic", onClose: () => void leaveMosaic().catch((error) => setWorkspaceError(String(error))) } : null}
        menuOpen={overflowOpen} onMenu={setOverflowOpen} onBookmarks={() => setBookmarksOpen(true)}
        onAppearance={() => setAppearanceOpen(true)} onPreferences={() => setPreferencesOpen(true)}
        onInspect={() => void picker.start(tabs.find(tab => tab.id === activeId)?.url ?? "")}
        onPrint={() => pageOutputRef.current("browser_print")} onSavePage={() => pageOutputRef.current("browser_save_page")}
        onCloseBrowser={onClose}/>}

      {videoFs.stage === "browser" && <BrowserFullscreenEdge title={tabs.find((tab) => tab.id === activeId)?.title ?? "Video"}
        onScreen={() => void videoFs.requestScreen()} onExit={() => videoFs.dispatch({ type: "exit" })}/>}
      {/* The active tab's native webview is positioned to cover this slot. When
          the page-discussion panel is open, a SplitPane shrinks the slot so the
          webview shares the pane with the chat (the webview tracks the slot's
          rect, so it resizes automatically). */}
      {(() => {
        const slot = <BrowserTileStage stageRef={slotRef} slots={tileSlotsRef} pages={tilePages} tabs={tabs} activeId={activeId} layout={stageLayout} fullscreen={browserFullscreen}
          renderHome={page => <Suspense fallback={<div className="rb-page-cover">Opening new tab…</div>}><BrowserHomePage tabs={tabs} onOpen={url => { const open = tabs.find(tab => tab.url === url && tab.id !== page.id); if (open) selectTab(open.id); else navigate(url, page.id); }} onMission={id => void switchToMission(id)}/></Suspense>} shots={tabShots} showShots={!effectiveVisible} errors={pageErrors} loading={new Set(tilePages.filter((page) => page.url !== NEWTAB && (!wvMapRef.current.has(page.id) || reloading.has(page.id)) && !pageErrors[page.id]).map((page) => page.id))} onRetry={retryPage} onFocus={selectTab}
          onAssign={(index, browseId) => { const next = assignVisibleTile(tileLayout, visibleBrowseIds, index, browseId); updateTileLayout(next); const tab = tabs.find((t) => t.browseId === browseId); if (tab) selectTab(tab.id); }}
          onAddPage={(index) => { const browseId = openTab(); if (browseId) updateTileLayout(assignTile(tileLayout, index, browseId)); }}
          onSwap={(from, to) => updateTileLayout(swapVisibleTiles(tileLayout, visibleBrowseIds, from, to))}
          hoveredTileTab={hoveredTileTab} onHoverTile={setHoveredTileTab}
          onLayout={updateTileLayout} onDragging={setTileDragging}/>;
        // The conversation remains mounted and visible during stage one.
        if (!chatOpen || !dockSlot) return slot;
        const activeTab = tabs.find((t) => t.id === activeId) ?? tabs[0];
        // No switcher of its own any more: the dock's context strip is the one
        // place in the app that says which conversation you are in.
        const chatPanel = (
          <div className="rb-chat-frame">
            <div className="flex flex-1 flex-col min-w-0 min-h-0 overflow-hidden">
              {chatTab === "cart" ? (
                <Suspense fallback={<div className="h-full" />}>
                  <Cart
                    key={`${workspaceKey}:${listReloadKey}`}
                    workspaceKey={workspaceKey}
                    source={{ url: activeTab.url, title: activeTab.title }}
                    capturePage={capturePage}
                    onLocate={refineLocator}
                    onClose={() => setChatHere({ open: false })}
                    onSendToDrafter={onSendToDrafter}
                    onSendToRedline={onSendToRedline}
                    // `💬` on an item: the page agent already grounds on the
                    // live page and can read the repo, so it is the right
                    // colleague — this needs no backend of its own.
                    onDiscussItem={(quoted) => {
                      seedPageChat({ text: quoted, nonce: Date.now(), source: { kind: "task-item" } });
                      setChatHere({ open: true, pill: "page" });
                    }}
                  />
                </Suspense>
              ) : chatTab === "mission" ? (
                mission.activeMission ? (
                  <MissionChat
                    key={mission.activeMission.missionId}
                    mission={mission.activeMission}
                    findings={mission.findings}
                    projectDir={projectDir}
                    onClose={() => setChatHere({ open: false })}
                    onOpenLink={(url) => openTab(url)}
                    onRemoveFinding={(id) => void mission.removeFinding(id)}
                    onJumpToFinding={(bid) => {
                      const t = tabsRef.current.find((x) => x.browseId === bid);
                      if (t) {
                        selectTab(t.id);
                        // Written against the JUMPED-TO tab: the pill belongs
                        // to the tab we're landing on, and `activeId` hasn't
                        // committed yet.
                        setChatFor(t.browseId, { open: true, pill: "page" });
                      }
                    }}
                    onEditGoal={(title, goal) =>
                      mission.activeMission &&
                      void mission.setGoal(mission.activeMission.missionId, title, goal)
                    }
                    onSynthesize={onSynthesizeToDrafter}
                    synthesizeAsked={synthesizeAsked}
                    onSynthesizeStarted={() => setSynthesizeAsked(false)}
                  />
                ) : (
                  <MissionEmptyState onStart={() => setMissionDialogOpen(true)} />
                )
              ) : conversation && (
                <div className="rb-chat-frame">
                  <div className="flex flex-1 flex-col min-h-0 min-w-0 overflow-hidden">
                <BrowserChat
                  key={conversation.browseId}
                  conversation={conversation}
                  workspace={workspaceKey}
                  linkedMode={chatWorld.linkedMode}
                  onToggleTabChat={chatHandlers.toggleTabChat}
                  onToggleLinkedMode={chatHandlers.toggleLinkedMode}
                  onResearch={chatHandlers.research}
                  pageActions={pageActions.running}
                  onPickElement={/^https?:\/\//i.test(activeTab.url) ? chatHandlers.pickElement : undefined}
                  taskList={chatTaskList}
                  mission={chatMission}
                  projectDir={projectDir}
                  onClose={chatHandlers.close}
                  onOpenLink={chatHandlers.openLink}
                  seed={chatSeed}
                  onSeedConsumed={chatHandlers.seedConsumed}
                  onAddToCart={chatHandlers.addToCart}
                  onAddToMission={mission.activeMission ? chatHandlers.addToMission : undefined}
                />
                  </div>
                </div>
              )}
            </div>
          </div>
        );
        // The pane keeps the whole slot; the panel goes to the app's one
        // conversation column. A portal rather than a lift: everything the
        // panel needs is this component's state.
        return (
          <>
            {slot}
            {createPortal(chatPanel, dockSlot)}
          </>
        );
      })()}

      </div>
      {picker.picking && <div role="status" className="shrink-0 px-3 py-1 text-xs">Click an element · Esc to cancel <button type="button" onClick={picker.cancel}>Cancel</button></div>}
      {workspaceError && <div role="alert" className="flex items-center justify-between px-3 py-2 text-xs" style={{ color: "var(--color-danger)", background: "var(--color-paper)" }}>{workspaceError}<button type="button" onClick={() => setWorkspaceError(null)}>Dismiss</button></div>}
      {mission.error && <div role="alert" className="px-3 py-2 text-xs">{mission.error}<button type="button" onClick={() => void mission.refreshMissions()}>Retry</button></div>}
      {appearanceOpen && <BrowserAppearanceMenu site={siteKey(activeUrl)} value={normalizeAppearance(siteAppearances[siteKey(activeUrl)])} onChange={(profile) => setSiteAppearances((prev) => ({ ...prev, [siteKey(activeUrl)]: profile }))} onClose={() => setAppearanceOpen(false)}/>}
      {layoutMenuOpen && <BrowserLayoutDialog layout={tileLayout} available={tabs.length} tabs={tabs} activeBrowseId={activeBrowseId ?? ""} onClose={() => setLayoutMenuOpen(false)}
        onChoose={(preset, count) => updateTileLayout({ ...tileLayout, grid: undefined, preset, maximized: null, tiles: arrangementTiles(tileLayout, tabs.map(tab => tab.browseId), activeBrowseId!, count) })}
        onSaveDefault={() => setLayouts((prev) => ({ ...prev, default: { ...tileLayout, grid: undefined, tiles: [], maximized: null, focused: null } }))}/>}
      {bookmarksOpen && <BrowserBookmarksDialog bookmarks={bookmarks} title={tabs.find((tab) => tab.id === activeId)?.title ?? activeUrl} url={activeUrl} onSave={saveBookmarkFor} onRemove={removeBookmark} onOpen={(url) => openTab(url)} onClose={() => setBookmarksOpen(false)}/>}
      {preferencesOpen && <BrowserPreferencesDialog selectionActions={selectionActions} onSelectionActions={setSelectionActions} onClose={() => setPreferencesOpen(false)}/>}
      {missionMenuOpen && <MissionMenu missions={mission.missions} activeId={mission.activeMission?.missionId ?? null}
        onStartNew={() => { setMissionMenuOpen(false); setMissionDialogOpen(true); }}
        onResume={(id) => { setMissionMenuOpen(false); void switchToMission(id).then(() => setChatHere({ open: true, pill: "mission" })).catch((error) => setWorkspaceError(String(error))); }}
        onExit={() => { setMissionMenuOpen(false); void exitMission().catch((error) => setWorkspaceError(String(error))); }}
        onDelete={(id) => { void deleteMissionFlow(id).catch((error) => setWorkspaceError(String(error))); }}
        onOpenWorkspace={() => { setMissionMenuOpen(false); setMissionFoundationOpen(true); }} onClose={() => setMissionMenuOpen(false)}/>}
      {mosaicsOpen && <MosaicManagerDialog mosaics={mosaicList} error={mosaicError} activeId={isMosaicWorkspace(workspaceKey) ? workspaceKey : null} activeName={activeMosaic?.name ?? null}
        startupId={startupMosaic} canSaveCurrent={tabs.some((tab) => /^https?:\/\//i.test(tab.url))}
        onOpen={(id) => { setMosaicsOpen(false); void openMosaic(id).catch((error) => setWorkspaceError(String(error))); }}
        onEdit={(id) => { void editMosaic(id).catch((error) => setMosaicError(String(error))); }}
        onNew={() => newMosaic(false)} onSaveCurrent={() => newMosaic(true)}
        onDelete={(id) => { void deleteMosaicFlow(id).catch((error) => setMosaicError(`The mosaic could not be deleted. ${String(error)}`)); }}
        onStartup={setStartupMosaic}
        onLeave={() => { setMosaicsOpen(false); void leaveMosaic().catch((error) => setWorkspaceError(String(error))); }}
        onClose={() => setMosaicsOpen(false)}/>}
      {mosaicEdit && <MosaicEditDialog draft={mosaicEdit.draft} previous={mosaicEdit.previous} createId={newBrowseId}
        onSave={(next) => saveMosaicEdit(next, !mosaicEdit.previous)}
        onCancel={() => { setMosaicEdit(null); openMosaicManager(); }}/>}
      {missionFoundationOpen && mission.activeMission && <BrowserDialog title="Research workspace" subtitle={mission.activeMission.title} width={1040} onClose={() => setMissionFoundationOpen(false)}>
        <Suspense fallback={<div className="p-4">Opening saved research…</div>}><MissionFoundationPanel missionId={mission.activeMission.missionId} tabIds={tabs.map((t) => t.id)} initialBrief={mission.activeMission.goal} onOpenDraft={onOpenDraft} onContinue={(destination, body, handoffId) => onMissionContinue?.(mission.activeMission!.missionId, destination, body, handoffId)}/></Suspense>
      </BrowserDialog>}
      {missionDialogOpen && (
        <MissionStartDialog
          onCancel={() => setMissionDialogOpen(false)}
          onStart={(title, goal) => {
            setMissionDialogOpen(false);
            void startNewMission(title, goal).catch((error) => setWorkspaceError(String(error)));
          }}
        />
      )}
    </div>
  );
}


function MissionEmptyState({ onStart }: { onStart: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-3 px-6 text-center">
      <Target size={28} strokeWidth={1.5} style={{ color: "var(--color-ink-muted)" }} />
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
        Start a mission
      </button>
    </div>
  );
}

/** Start / switch / resume dropdown hung off the toolbar 🎯. Rendered as React
 *  DOM with the native webview hidden (the pane drops `visible` while it's open),
 *  same reason bookmarks use a native popup. */
function MissionMenu({ missions, activeId, onStartNew, onResume, onExit, onDelete, onOpenWorkspace, onClose }: {
  missions: Mission[]; activeId: string | null; onStartNew: () => void;
  onResume: (id: string) => void; onExit: () => void; onDelete: (id: string) => void;
  onOpenWorkspace: () => void; onClose: () => void;
}) {
  const [deleting, setDeleting] = useState<Mission | null>(null);
  return <BrowserDialog title="Research missions" subtitle="Explore a question across pages and keep findings together." onClose={onClose}>
    {deleting ? <div>
      <h3 className="text-base font-medium">Delete “{deleting.title}”?</h3>
      <p className="rb-help">This removes its saved findings, conversation and pages. This cannot be undone.</p>
      <div className="flex gap-2 mt-4"><button type="button" className="rb-button" onClick={() => setDeleting(null)}>Keep research</button><button type="button" className="rb-button" style={{ color: "var(--color-danger)" }} onClick={() => { onDelete(deleting.missionId); setDeleting(null); }}>Delete research</button></div>
    </div> : <>
      <div className="flex flex-wrap gap-2 mb-3"><button type="button" className="rb-button rb-button-primary" onClick={onStartNew}>Start a research mission</button>
        {activeId && <><button type="button" className="rb-button" onClick={onOpenWorkspace}>Open research workspace</button><button type="button" className="rb-button" onClick={onExit}>Return to regular browsing</button></>}
      </div>
      {missions.map((item) => <div key={item.missionId} className="rb-setting">
        <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onResume(item.missionId)} style={{ background: "none", border: 0, color: "inherit", cursor: "pointer" }}>
          <span className="truncate">{item.title}</span><small>{item.missionId === activeId ? "Current mission" : "Resume"}</small>
        </button>
        <button type="button" className="rb-icon-button" aria-label={`Delete ${item.title}`} onClick={() => setDeleting(item)}><X size={14}/></button>
      </div>)}
      {!missions.length && <p className="rb-help">Start with a question or a goal. Your research conversation can work across the pages you open.</p>}
    </>}
  </BrowserDialog>;
}

/** Memoized: one of the center-pane surfaces that used to reconcile on
 *  every frame of a divider drag. */
export const BrowserPane = memo(BrowserPaneBase);
