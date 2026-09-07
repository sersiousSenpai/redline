// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { lazy, memo, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { rafCoalesce } from "../lib/raf";
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  Link2,
  ListChecks,
  MessageSquare,
  Palette,
  Plus,
  Settings,
  Star,
  Target,
  X,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Window } from "@tauri-apps/api/window";
import { Webview } from "@tauri-apps/api/webview";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { usePersistedState } from "../theme/usePersistedState";
import { resolveOmniboxInput } from "../lib/omnibox";
import {
  chatEntryFor,
  pruneChatState,
  withChatPatch,
  type BrowserDockState,
  type ChatPill,
  type ChatStateMap,
} from "../lib/browseChatState";
import { isLocalhostUrl, sameTabUrl, templateFor } from "../lib/browseList";
import {
  autoSends,
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
// `BrowserPane` is a static import in App, so it sits in the boot path. The
// list panel only exists once a user picks the pill, so it has no business
// costing boot bytes — and `scripts/size-budget.json` has limited headroom.
const BrowseList = lazy(() => import("./BrowseList"));
import type {
  BinaryFile,
  BrowseFocusTabEvent,
  BrowseListView,
  BrowseOpenTabEvent,
  BrowseWakeTabEvent,
  Mission,
} from "../types";
import { onResizeSession } from "../lib/resizeSession";
import { BrowserChat } from "./BrowserChat";
import { MissionChat } from "./MissionChat";
import { LinkedChat } from "./LinkedChat";
import { MissionStartDialog } from "./MissionStartDialog";
import { useMission } from "../hooks/useMission";
import { useLinked } from "../hooks/useLinked";

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
// Not a UX limit — like Safari/Chrome there's no real cap on how many tabs you
// keep, because idle tabs are SUSPENDED (only `MAX_LIVE_WEBVIEWS` are ever live
// at once), so memory is bounded by live webviews, not by strip length. This
// high ceiling exists ONLY as a runaway guard: the new-tab interceptor opens a
// tab per `window.open`/`target=_blank`, so a buggy or hostile page could spam
// them — the same thing browsers' popup blockers defend against.
const MAX_TABS = 100;
// Cap on simultaneously-live native webviews (active + MRU). The rest are
// suspended to the snapshot cache. Tunable.
const MAX_LIVE_WEBVIEWS = 3;
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

/** Px the measured webview slot is inset from its frame element. The native
 *  webview is a square rect composited over a rounded plate (radius 10): a
 *  square inset by at least r·(1−1/√2) ≈ 3px can never cross the border curve,
 *  so 4px keeps the page clear of the plate's corners without reading as a
 *  gap. Exported (with the helper below) so the geometry is pinned by test. */
export const WEBVIEW_PLATE_INSET = 4;
/** Fullscreen is a square window takeover — no plate, no inset. */
export const webviewSlotInset = (fullscreen: boolean): number =>
  fullscreen ? 0 : WEBVIEW_PLATE_INSET;

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

/** Move the tab `dragId` to sit immediately before `overId` (drag-to-reorder).
 *  Tab NUMBERS are purely positional — the strip shows `index + 1` and the
 *  daemon's `/v1/browser/tabs` derives `n` from list position — so reordering
 *  the array is all that's needed for "drag tab 9 onto tab 2 → it becomes tab
 *  2" to hold for both the user and the agent. Durable `id`/`browseId` ride
 *  along with each tab. Returns the same array reference when nothing moves. */
export function reorderTabs<T extends { id: string }>(
  tabs: T[],
  dragId: string,
  overId: string,
): T[] {
  if (dragId === overId) return tabs;
  const from = tabs.findIndex((t) => t.id === dragId);
  const to = tabs.findIndex((t) => t.id === overId);
  if (from < 0 || to < 0) return tabs;
  const next = tabs.slice();
  const [moved] = next.splice(from, 1);
  // After removing `from`, a rightward target shifts down by one; insert the
  // dragged tab just before the hovered one either way.
  next.splice(from < to ? to - 1 : to, 0, moved);
  return next;
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
  /** Open a page-discussion reply in the Prompt Drafter (repo pre-guessed) to
   *  shape before sending. Forwarded to the chat's per-reply action. */
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
  openRequest?: { url: string; nonce: number } | null;
  /** Called once the pane has acted on `openRequest`, so the owner clears it.
   *  Without this the request outlives its click: `lastOpenNonceRef` resets on
   *  every mount, so each browser-surface re-entry replayed the stale request
   *  and appended another tab. */
  onOpenRequestConsumed?: () => void;
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
   *  everything they need — the tab list, `useMission`, `useLinked`, the
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
  visible = true,
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
  // A picture of each tab, for the resize stand-in below. Kept as data URLs
  // keyed by tab id, refreshed on the same settle the DOM snapshot uses.
  const [tabShots, setTabShots] = useState<Map<string, string>>(
    () => new Map(),
  );
  const scheduleCacheSnapshot = useCallback((id: string, delay = 800) => {
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
        const onScreen = id === activeIdRef.current && visibleRef.current;
        void invoke("browser_cache_snapshot", { label, onScreen }).catch(() => {});
        // Piggyback a picture on the same settle. Only the tab that is
        // actually on screen: WebKit snapshots a hidden view blank, and a
        // blank stand-in is worse than none. Deliberately here rather than at
        // drag start — a capture then would be exactly the hitch we're
        // removing, so a drag uses whatever picture already exists.
        if (id !== activeIdRef.current || !visibleRef.current) return;
        const el = slotRef.current;
        const width = Math.round(el?.getBoundingClientRect().width ?? 0);
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
      setLiveVersion((v) => v + 1);
    }
  }, []);
  // Move a tab to the front of the recency order (most-recently-used first).
  const touchMru = useCallback((id: string) => {
    mruRef.current = [id, ...mruRef.current.filter((x) => x !== id)];
  }, []);

  const [tabs, setTabs] = useState<Tab[]>(initialTabsRef.current);
  const [activeId, setActiveId] = useState(() => initialActiveRef.current!);
  // Which tab's DISCUSSION thread the chat pane shows. Normally equals activeId,
  // but they diverge when the agent opens a tab on the user's behalf: the new
  // tab becomes the visible/active page (activeId), while the conversation stays
  // anchored to the tab it was started from (discussionId) so the in-flight
  // reply isn't interrupted and the one conversation keeps driving the new tab.
  // Any manual tab click re-couples them (see selectTab).
  const [discussionId, setDiscussionId] = useState(
    () => initialActiveRef.current!,
  );
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
    {},
  );
  // Keyed on the ACTIVE tab, not `discussionId`: the memory should follow the
  // tab the user is looking at, and those two deliberately diverge when an
  // agent opens a tab on the current conversation's behalf.
  const activeBrowseId =
    (tabs.find((t) => t.id === activeId) ?? tabs[0])?.browseId ?? null;
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
    /** Set by the one-tap highlight actions (Define/Explain/Research): the
     *  intent line is already a complete instruction, so the turn goes out
     *  rather than sitting in the composer waiting for a ⌘↵ that confirms
     *  nothing. See lib/browseSelection.ts. */
    autoSend?: boolean;
  } | null>(null);
  // Which tabs are known to HAVE a list. Drives the auto-offer below and the
  // "＋ Add as item" action in the page chat; `BrowseList` reports both
  // directions so neither has to poll.
  const [listedTabs, setListedTabs] = useState<Record<string, boolean>>({});
  // Bumped after a highlight writes into a list, so an already-open list panel
  // remounts and shows the item instead of silently going stale (it loads from
  // the DB on mount and has no reason to poll).
  const [listReloadKey, setListReloadKey] = useState(0);

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

  /** ＋ List, from the in-page highlight bar.
   *
   *  `browse_list_add` refuses an item with no list (browse_list.rs) — which is
   *  why the chat's "＋ Add as item" is offered only once one exists. From a
   *  highlight, creating it IS the right move.
   *
   *  The item is the NOTE the user typed into the bar, not the passage they
   *  highlighted: the passage is where they were pointing, and filing it as the
   *  item wrote the page's own words into the user's list.
   *
   *  It reads the tab's real list
   *  rather than trusting `listedTabs` (only populated once the panel has been
   *  open) and rather than calling `browse_list_start` blindly, which would
   *  silently re-point an existing list at the punch-list template. */
  const addSelectionToList = useCallback(
    async (browseId: string, ev: SelectionEvent) => {
      try {
        const existing = await invoke<BrowseListView | null>("browse_list_get", {
          browseId,
        });
        const template = existing?.list.template ?? "punch-list";
        if (!existing) {
          await invoke("browse_list_start", {
            browseId,
            template,
            title: ev.title.trim() || null,
          });
        }
        // The bar's own `url`/`title` win over a fresh capture here: they were
        // read at the instant of the tap, and an SPA route change between the
        // tap and this write would file the item under the page they left.
        const item = await invoke<{ id: string }>("browse_list_add", {
          browseId,
          kind: templateFor(template).defaultKind,
          body: ev.note,
          pageUrl: ev.url || null,
          pageTitle: ev.title || null,
          locator: fallbackLocator(ev.locator) || null,
        });
        refineLocator(item.id, ev.text, ev.locator);
        setListedTabs((prev) => (prev[browseId] ? prev : { ...prev, [browseId]: true }));
        setListReloadKey((n) => n + 1);
        // Show where it went. A write with no visible landing place reads as a
        // dropped tap, and the panel is one pill away regardless. The PANEL
        // state is keyed on the active tab (that's whose pane this is), even
        // when the item itself went to the anchored discussion's list.
        setChatHere({ open: true, pill: "list" });
      } catch (e) {
        console.error("highlight ＋ List failed", e);
      }
    },
    [setChatHere, refineLocator],
  );

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
      // Address the tab whose conversation the pane is actually SHOWING. That
      // is normally the active tab; the two diverge only when the agent opened
      // a page on the user's behalf and the conversation stayed anchored to the
      // tab it started from — and that anchored conversation is exactly the one
      // that should hear what the user highlighted on the page it opened.
      const browseId =
        tabs.find((t) => t.id === discussionId)?.browseId ?? activeBrowseIdRef.current;
      if (!browseId) return;
      if (ev.action === "list") {
        void addSelectionToList(browseId, ev);
        return;
      }
      setChatSeed({
        text: promptForSelection(ev),
        nonce,
        autoSend: autoSends(ev.action),
      });
      setChatHere({ open: true, pill: "page" });
    },
    [tabs, discussionId, addSelectionToList, setChatHere],
  );
  // The 250 ms poll below runs on a `[]`-deps effect; read through a ref so it
  // never has to resubscribe (same pattern as `openTabRef`).
  const dispatchSelectionRef = useRef(dispatchSelection);
  dispatchSelectionRef.current = dispatchSelection;

  // The localhost auto-offer.
  //
  // On a tab showing the user's own dev server, with no list and no
  // conversation yet, opening the panel lands on the List chooser rather than
  // the page chat — because that is what people actually want there: not only
  // a conversation, but a running tally of what needs to change.
  //
  // Strictly a FIRST-OPEN offer. Once a template is picked or a page message is
  // sent, both probes come back non-empty and §2's remembered pill takes over;
  // the probed set stops it re-firing within a session even before that, so a
  // user who opens the panel and switches to This page isn't flipped back. A
  // mode that fights the user is worse than no offer at all.
  const offeredListRef = useRef<Set<string>>(new Set());
  const activeTabUrl = (tabs.find((t) => t.id === activeId) ?? tabs[0])?.url ?? "";
  useEffect(() => {
    if (!chatOpen || !activeBrowseId) return;
    if (!isLocalhostUrl(activeTabUrl)) return;
    if (offeredListRef.current.has(activeBrowseId)) return;
    offeredListRef.current.add(activeBrowseId);
    const bid = activeBrowseId;
    void Promise.all([
      invoke<unknown | null>("browse_list_get", { browseId: bid }),
      invoke<unknown[]>("get_browse_thread", { browseId: bid }),
    ])
      .then(([list, thread]) => {
        if (list || (Array.isArray(thread) && thread.length > 0)) return;
        // Still the tab the user is looking at? Two round-trips is enough time
        // to have moved on, and yanking a pill on a tab they left is exactly
        // the kind of thing that makes a surface feel possessed.
        if (activeBrowseIdRef.current !== bid) return;
        setChatFor(bid, { pill: "list" });
      })
      .catch(() => {});
  }, [chatOpen, activeBrowseId, activeTabUrl, setChatFor]);
  // Research-mission state (active mission, its pins, the resumable list).
  // Mirrors itself to the backend so the daemon's /v1/mission/* routes can
  // answer the orchestrator. See useMission.
  const mission = useMission();
  // Linked-discussion state (one continuous conversation across all tabs).
  const linked = useLinked();
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
    missionRestorePendingRef.current = mission.activeMissionId !== null;
  }
  // Debounce timer for saving the active mission's tab workspace.
  const missionTabsTimerRef = useRef<number | null>(null);
  // Tab drag-to-reorder. `tabDragging` hides the native webview during a drag
  // (so it doesn't swallow the pointer, same rule as the split divider);
  // `dragOverId` is the tab the pointer is currently over (drop target).
  const [tabDragging, setTabDragging] = useState(false);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  // Live drag bookkeeping read by the window pointer listeners without stale
  // closures: the tab being dragged, whether the pointer has moved past the
  // click threshold, and the current drop target.
  const tabDragRef = useRef<{ id: string; startX: number; moved: boolean } | null>(
    null,
  );
  const dragOverIdRef = useRef<string | null>(null);
  // Set true on pointer-up of a real drag so the follow-up click doesn't also
  // fire `selectTab` (a drag shouldn't switch tabs).
  const suppressTabClickRef = useRef(false);
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
  // Tandem agent mode: an agent-first browsing behavior. When on, every tab
  // lands in a 50/50 browser | page-discussion split and the browse agent is
  // told to open the best page for definition/concept/library questions and
  // surface rateable sources. Toggled from the ⚙️ toolbar menu; persisted.
  const [tandem, setTandem] = usePersistedState<boolean>(
    "redline.browser.tandem",
    false,
  );
  // Read inside the native settings-menu handler without re-subscribing.
  const tandemRef = useRef(tandem);
  tandemRef.current = tandem;
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
  // Tell the dock which conversations exist beside this pane. Only ids and
  // labels cross — the panels themselves stay here and are portalled into the
  // dock's slot, so this is a description, never a second copy of the state.
  //
  // The discussion tab, not the active one: that is whose thread the page
  // conversation shows, and the two deliberately diverge when an agent opens a
  // tab on the current conversation's behalf.
  const dockDiscussionTab =
    tabs.find((t) => t.id === discussionId) ??
    tabs.find((t) => t.id === activeId) ??
    tabs[0];
  const dockBrowseId = dockDiscussionTab?.browseId ?? null;
  const dockTitle = dockDiscussionTab?.title ?? null;
  const dockLinkedId = linked.activeLinkedId ?? null;
  const dockMissionId = mission.activeMission?.missionId ?? null;
  const dockMissionTitle = mission.activeMission?.title ?? null;
  const dockMemoPill = chatHere.pill;
  useEffect(() => {
    onDockState?.({
      browseId: dockBrowseId,
      title: dockTitle,
      pill: dockMemoPill,
      linkedId: dockLinkedId,
      missionId: dockMissionId,
      missionTitle: dockMissionTitle,
    });
  }, [
    onDockState,
    dockBrowseId,
    dockTitle,
    dockMemoPill,
    dockLinkedId,
    dockMissionId,
    dockMissionTitle,
  ]);
  // The native webview is hidden whenever the pane is logically hidden, the
  // chat divider is being dragged, or an HTML overlay we own is up (the mission
  // start dialog / menu) — a native webview paints OVER React DOM, so it must
  // step aside for those, the same reason bookmarks use a native popup menu.
  const effectiveVisible =
    visible &&
    !tabDragging &&
    !missionDialogOpen &&
    !missionMenuOpen;
  const visibleRef = useRef(effectiveVisible);
  visibleRef.current = effectiveVisible;

  // True for the length of any drag anywhere in the app. The native webview
  // cannot ride a drag — it is a sibling OS view that always paints above the
  // main webview and steals the pointer at the OS level, so DOM pointer capture
  // can't save it and it must hide. What it must NOT do is leave a blank
  // rectangle: for the duration, the tab's last picture stands in.
  const [resizing, setResizing] = useState(false);
  useEffect(() => onResizeSession(setResizing), []);

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
    // Remember the active tab so a remount (document-pane toggle) restores it.
    // Skip while a mission owns the workspace, a swap is mid-flight, or a
    // mission restore is still pending — those states aren't the global
    // regular-browsing one.
    if (
      !activeMissionIdRef.current &&
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
      void invoke("browser_install_shims", {
        label: tab.label,
        selectionActions: selectionActionsRef.current,
      }).catch(() => {});
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
              selectionActions: selectionActionsRef.current,
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
    const ro = new ResizeObserver(scheduleSync);
    ro.observe(el);
    return () => ro.disconnect();
  }, [scheduleSync]);

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
  // ~250ms keeps fullscreen and link-clicks responsive without churn.
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
        const raw = await invoke<string>("browser_eval_result", {
          label: `browser-${id}`,
          script:
            '(function(){try{var q=window.__redline_newtabs||[];window.__redline_newtabs=[];' +
            'var s=window.__redline_selections||[];window.__redline_selections=[];' +
            'return JSON.stringify({fs:!!window.__redline_fs,tabs:q,sel:s})}catch(e){return "{}"}})()',
        });
        if (cancelled) return;
        let sig: { fs?: boolean; tabs?: unknown; sel?: unknown } = {};
        try {
          sig = JSON.parse(raw || "{}");
        } catch {
          /* malformed — treat as no signal */
        }
        setBrowserFullscreen(!!sig.fs);
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
      const all = await Webview.getAll().catch(() => []);
      const ours = new Set(tabsRef.current.map((t) => t.label));
      const activeLabel = `browser-${activeIdRef.current}`;
      for (const wv of all) {
        if (!wv.label.startsWith("browser-")) continue;
        if (!ours.has(wv.label)) {
          // Stray from a prior instance whose tab set differs — free it.
          closeWebview(wv.label);
        } else if (wv.label !== activeLabel) {
          // Ours, but not the active tab. On a remount our wvMapRef starts
          // empty, so the previously-active webview from the old instance is
          // untracked and would stay SHOWN at its stale (full-column) bounds,
          // painting over the document. Only the active tab is ever shown, so
          // hide every other live webview now; syncBounds shows the active one.
          void wv.hide();
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
    // A drag just ended on this tab — that's a reorder, not a selection.
    if (suppressTabClickRef.current) {
      suppressTabClickRef.current = false;
      return;
    }
    // Selecting a suspended tab wakes it: ensure it has a live webview (recreate
    // if its prior one died or never materialized), and bump its recency.
    ensureLive(id);
    touchMru(id);
    setActiveId(id);
    setDiscussionId(id);
  };

  // Begin a potential tab drag-reorder. A small threshold distinguishes a drag
  // from a click; only past it do we hide the webview, dim the dragged tab, and
  // track a drop target (the tab under the pointer, found via `data-tab-id`).
  // Reorders on release — tab numbers follow list position automatically.
  const startTabDrag = (e: React.PointerEvent, id: string) => {
    if (e.button !== 0) return;
    // A press that starts on the ✕ close button is a close, not a drag.
    if ((e.target as HTMLElement).closest("button")) return;
    tabDragRef.current = { id, startX: e.clientX, moved: false };
    dragOverIdRef.current = null;
    // `elementFromPoint` forces layout and `setDragOverId` re-renders the
    // strip — both were running at raw pointer rate. One drop-target
    // resolution per frame is all the highlight can show anyway.
    const hitTest = rafCoalesce((x: number, y: number, selfId: string) => {
      const el = document.elementFromPoint(x, y) as HTMLElement | null;
      const over = el?.closest("[data-tab-id]") as HTMLElement | null;
      const overId = over?.getAttribute("data-tab-id") ?? null;
      dragOverIdRef.current = overId;
      setDragOverId(overId ?? selfId);
    });
    const onMove = (ev: PointerEvent) => {
      const st = tabDragRef.current;
      if (!st) return;
      if (!st.moved && Math.abs(ev.clientX - st.startX) < 5) return;
      if (!st.moved) {
        st.moved = true;
        setTabDragging(true);
        setDragOverId(st.id);
      }
      hitTest(ev.clientX, ev.clientY, st.id);
    };
    const onUp = () => {
      // Resolve the final drop target before reading it below, so a release
      // inside the same frame as the last move still lands on the right tab.
      hitTest.flush();
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      const st = tabDragRef.current;
      tabDragRef.current = null;
      const overId = dragOverIdRef.current;
      dragOverIdRef.current = null;
      setTabDragging(false);
      setDragOverId(null);
      if (st?.moved) {
        // Swallow the click that follows this pointer-up so it doesn't select.
        // A drag ending on a DIFFERENT tab may fire no click at all, which would
        // leave the flag stuck — so also clear it on the next macrotask (the
        // real click, if any, fires synchronously before that and consumes it).
        suppressTabClickRef.current = true;
        window.setTimeout(() => {
          suppressTabClickRef.current = false;
        }, 0);
        if (overId && overId !== st.id) {
          setTabs((ts) => reorderTabs(ts, st.id, overId));
        }
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const openTab = (
    url: string = HOME,
    opts: { anchorDiscussion?: boolean } = {},
  ) => {
    // Opening an already-open URL foregrounds that tab instead of stacking a
    // duplicate — "Open" on a Localhost card (and any replayed request) would
    // otherwise accumulate tabs. `sameTabUrl`, not `===`: the poll below
    // rewrites `t.url` to the webview's canonical URL, so a tab opened at
    // `http://localhost:3000` is holding `http://localhost:3000/dashboard` by
    // the time you click the card again. Blank tabs are exempt: "+" on HOME is
    // an intentional second empty tab.
    if (url !== HOME) {
      const existing = tabsRef.current.find((t) => sameTabUrl(t.url, url));
      if (existing) {
        ensureLive(existing.id);
        touchMru(existing.id);
        setActiveId(existing.id);
        if (!opts.anchorDiscussion) setDiscussionId(existing.id);
        return;
      }
    }
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
    // Tandem mode is agent-first: every new tab lands in the split so the user
    // can ask straight away. Written against the NEW tab's browseId, not the
    // active one — `activeId` hasn't committed yet at this point.
    if (tandemRef.current) setChatFor(tab.browseId, { open: true, pill: "page" });
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
    // The swap ends when THIS array commits — the `[tabs]` effect matches it
    // by identity and clears `swappingRef` there. Resetting synchronously
    // here re-enabled persistence before that effect ran, leaking the
    // swapped-in tabs into the outgoing bucket.
    swapCommitRef.current = newSet;
    setTabs(newSet);
    setActiveId(active.id);
    setDiscussionId(active.id);
    setAddr(active.url);
    setLiveVersion((v) => v + 1);
    if (target.kind === "mission") mission.resumeMission(target.id);
    else mission.closeMission();
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

  // Convert a tab's page chat into the linked discussion — a fork, not a
  // move (the tab chat and its session are kept) — then land in the linked
  // panel, which shows the copied history behind a divider.
  const continueTabAsLinked = async (tab: Tab) => {
    const n = tabsRef.current.findIndex((t) => t.id === tab.id) + 1 || null;
    const l = await linked.convertFromBrowse({
      browseId: tab.browseId,
      tabN: n,
      tabTitle: tab.title,
      tabUrl: tab.url,
    });
    if (l) setChatHere({ open: true, pill: "linked" });
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
    if (!pendingId) {
      initDoneRef.current = true;
      missionRestorePendingRef.current = false;
      return;
    }
    if (mission.activeMission) {
      initDoneRef.current = true;
      // swapWorkspace raises `swappingRef` synchronously, so clearing the
      // restore gate here opens no unguarded window.
      missionRestorePendingRef.current = false;
      void swapWorkspace({ kind: "mission", id: pendingId });
    } else if (mission.missionsLoaded) {
      // The persisted mission no longer exists — resolve to regular browsing
      // rather than wedging the gate (which would silence persistence and
      // the daemon mirror forever).
      initDoneRef.current = true;
      missionRestorePendingRef.current = false;
      mission.closeMission();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mission.activeMissionId, mission.activeMission, mission.missionsLoaded]);

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
    if (!openRequest || openRequest.nonce === lastOpenNonceRef.current) return;
    lastOpenNonceRef.current = openRequest.nonce;
    openTabRef.current(openRequest.url, {});
    onOpenRequestConsumedRef.current?.();
  }, [openRequest]);

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
        void invoke("browser_set_view", {
          label: t.label,
          css,
          selectionActions: selectionActionsRef.current,
        }).catch((e) => console.error("browser_set_view failed", e));
      }
    }
  }, [viewMode]);

  // Same shape for the highlight-action toggle. `browser_set_view` rebuilds the
  // WHOLE user-script set, so it's also how the selection bar goes on and off —
  // and it evals the change into the already-loaded page, so unchecking the
  // setting is felt on the page you're reading rather than on the next
  // navigation. Runs on mount too (harmless: it reinstalls the same set).
  useEffect(() => {
    const css = cssForView(viewModeRef.current);
    for (const t of tabsRef.current) {
      if (wvMapRef.current.has(t.id)) {
        void invoke("browser_set_view", { label: t.label, css, selectionActions }).catch(
          (e) => console.error("browser_set_view failed", e),
        );
      }
    }
  }, [selectionActions]);

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

  // A click in the native browser Settings menu arrives here (same native-popup
  // reason as bookmarks/view): tandem agent mode and the highlight action bar.
  useEffect(() => {
    const p = listen<string>("browser-settings-action", (e) => {
      if (e.payload === "bset-tandem") setTandem((v) => !v);
      else if (e.payload === "bset-highlight") setSelectionActions((v) => !v);
    });
    return () => {
      void p.then((un) => un());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Open the native browser Settings popup, right-aligned under the ⚙️ button
  // (same anchoring math as the View menu).
  const SETTINGS_MENU_WIDTH = 180;
  const openSettingsMenu = (e: React.MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const margin = 8;
    const maxX = window.innerWidth - SETTINGS_MENU_WIDTH - margin;
    const x = Math.max(margin, Math.min(r.right - SETTINGS_MENU_WIDTH, maxX));
    void invoke("show_browser_settings_menu", {
      tandem: tandemRef.current,
      highlight: selectionActionsRef.current,
      x: Math.round(x),
      y: Math.round(r.bottom + 4),
    }).catch((err) => console.error("show_browser_settings_menu failed", err));
  };

  // Tandem agent mode drives the layout: force the page discussion open the
  // moment it turns on, so every browse/new-tab lands agent-first. Its width is
  // the dock's own now — the user's one column width, not a second ratio this
  // pane would snap out from under them.
  useEffect(() => {
    if (tandem) setChatHere({ open: true, pill: "page" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tandem]);

  // Lucide icons render at size 14 inside these (stroke currentColor, so the
  // active-state tinting keeps working); inline-flex centers icon and text
  // buttons alike.
  const chromeBtn: React.CSSProperties = {
    fontSize: "13px",
    lineHeight: 1,
    padding: "3px 7px",
    border: "1px solid var(--color-rule)",
    background: "var(--color-bg-elevated)",
    color: "var(--color-ink)",
    borderRadius: "4px",
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Tab strip + toolbar — hidden while a page is in-window fullscreen so
          the video fills the whole Redline window. */}
      {!browserFullscreen && (
        <>
      {/* Tab strip — scrolls horizontally when the pane is too narrow to show
          every tab (each tab keeps its width instead of being squeezed away),
          with the bar itself hidden: a scrollbar drawn under a row of tabs is
          chrome about chrome. Native `title=` tooltips here, not `.rl-tipwrap`,
          so the overflow constraint documented at TerminalTileHeader doesn't
          apply. */}
      <div
        className="rl-hide-scroll-x flex items-center gap-1 px-2 pt-2 overflow-x-auto"
        style={{ background: "var(--color-bg-elevated)" }}
      >
        {tabs.map((tab, i) => {
          const active = tab.id === activeId;
          return (
            <div
              key={tab.id}
              data-tab-id={tab.id}
              onClick={() => selectTab(tab.id)}
              onPointerDown={(e) => startTabDrag(e, tab.id)}
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
                borderLeft:
                  tabDragging && dragOverId === tab.id && tabDragRef.current?.id !== tab.id
                    ? "2px solid var(--color-info)"
                    : "1px solid var(--color-rule)",
                borderRight: "1px solid var(--color-rule)",
                background: active
                  ? "var(--color-paper)"
                  : "var(--color-bg-elevated)",
                color: active ? "var(--color-ink)" : "var(--color-ink-muted)",
                // Dim the tab being dragged; a subtle cue it's in motion.
                opacity: tabDragging && tabDragRef.current?.id === tab.id ? 0.5 : 1,
                // While reordering, the whole strip is a drag surface.
                cursor: tabDragging ? "grabbing" : "pointer",
                userSelect: "none",
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
                  display: "inline-flex",
                  alignItems: "center",
                }}
              >
                <X size={12} strokeWidth={2} />
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
            flexShrink: 0,
            display: "inline-flex",
            alignItems: "center",
            opacity: tabs.length >= MAX_TABS ? 0.4 : 1,
            cursor: tabs.length >= MAX_TABS ? "default" : "pointer",
          }}
        >
          <Plus size={15} strokeWidth={2} />
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
          <ArrowLeft size={14} strokeWidth={2} />
        </button>
        <button
          type="button"
          style={chromeBtn}
          title="Forward"
          aria-label="Forward"
          onClick={() => evalActive("history.forward()")}
        >
          <ArrowRight size={14} strokeWidth={2} />
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
          <Star
            size={14}
            strokeWidth={2}
            fill={isBookmarked ? "currentColor" : "none"}
          />
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
          <Palette size={14} strokeWidth={2} />
        </button>
        <button
          type="button"
          style={{
            ...chromeBtn,
            color: tandem ? "var(--color-info)" : "var(--color-ink)",
          }}
          title="Browser settings (tandem agent mode)"
          aria-label="Browser settings"
          aria-haspopup="menu"
          onClick={openSettingsMenu}
        >
          <Settings size={14} strokeWidth={2} />
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
              lineHeight: 1,
              padding: "3px 6px",
              display: "inline-flex",
              alignItems: "center",
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
                setChatHere({ open: true, pill: "mission" });
              } else {
                setMissionDialogOpen(true);
              }
            }}
          >
            <Target size={14} strokeWidth={2} />
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
                  lineHeight: 1,
                  padding: "0 4px",
                  display: "inline-flex",
                  alignItems: "center",
                  borderRadius: "0 3px 3px 0",
                  color: mission.activeMission ? "var(--color-info)" : "var(--color-ink-muted)",
                }}
                title="Missions: start, switch, resume"
                aria-label="Missions menu"
                aria-haspopup="menu"
                onClick={() => setMissionMenuOpen((x) => !x)}
              >
                <ChevronDown size={11} strokeWidth={2} />
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
          onClick={() =>
            chatOpen && chatTab === "page"
              ? setChatHere({ open: false })
              : setChatHere({ open: true, pill: "page" })
          }
        >
          <MessageSquare size={14} strokeWidth={2} />
        </button>
        <button
          type="button"
          style={{
            ...chromeBtn,
            color: chatOpen && chatTab === "list" ? "var(--color-info)" : "var(--color-ink)",
          }}
          title="This tab's list — collect what needs to change, then hand it over in one piece"
          aria-label="Tab list"
          aria-pressed={chatOpen && chatTab === "list"}
          onClick={() =>
            chatOpen && chatTab === "list"
              ? setChatHere({ open: false })
              : setChatHere({ open: true, pill: "list" })
          }
        >
          <ListChecks size={14} strokeWidth={2} />
        </button>
        <button
          type="button"
          style={{
            ...chromeBtn,
            color: chatOpen && chatTab === "linked" ? "var(--color-info)" : "var(--color-ink)",
          }}
          title="Linked discussion — one conversation that follows you across tabs"
          aria-label="Linked discussion"
          aria-pressed={chatOpen && chatTab === "linked"}
          onClick={() =>
            chatOpen && chatTab === "linked"
              ? setChatHere({ open: false })
              : // No lazy create here: with no active linked discussion the
                // panel shows the empty state, whose primary action can carry
                // the current tab's chat across (converting is a real choice,
                // not a silent side effect of opening the panel).
                setChatHere({ open: true, pill: "linked" })
          }
        >
          <Link2 size={14} strokeWidth={2} />
        </button>
        <button
          type="button"
          style={chromeBtn}
          title="Close browser"
          aria-label="Close browser"
          onClick={onClose}
        >
          <X size={14} strokeWidth={2} />
        </button>
      </div>
        </>
      )}

      {/* The active tab's native webview is positioned to cover this slot. When
          the page-discussion panel is open, a SplitPane shrinks the slot so the
          webview shares the pane with the chat (the webview tracks the slot's
          rect, so it resizes automatically). */}
      {(() => {
        // The stand-in. Shown only while the real webview is actually hidden,
        // so it can never sit under a live page. `cover` + a top-left origin
        // means it clips as the slot changes shape instead of distorting —
        // the page appears to be masked by the drag, which is what a page
        // being resized looks like. No fresh capture is taken here; if this
        // tab has no picture yet the pane is blank exactly as before.
        const shot = resizing && !effectiveVisible ? tabShots.get(activeId) : undefined;
        const slot = (
          // Frame + measured slot. The frame owns layout; the webview tracks
          // the INNER div's rect, inset from the frame so the square native
          // rect never pokes through the document plate's rounded corners.
          <div
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
          >
            <div
              ref={slotRef}
              style={{
                position: "absolute",
                inset: `${webviewSlotInset(browserFullscreen)}px`,
              }}
            >
              {shot && (
                <img
                  src={shot}
                  alt=""
                  aria-hidden
                  draggable={false}
                  style={{
                    position: "absolute",
                    inset: 0,
                    width: "100%",
                    height: "100%",
                    objectFit: "cover",
                    objectPosition: "top left",
                    pointerEvents: "none",
                  }}
                />
              )}
            </div>
          </div>
        );
        // Fullscreen takes over the whole pane; a closed dock (or one holding
        // another surface's conversation) leaves nowhere to portal into.
        if (browserFullscreen || !chatOpen || !dockSlot) return slot;
        const activeTab = tabs.find((t) => t.id === activeId) ?? tabs[0];
        // The chat shows the DISCUSSION tab's thread (usually the active tab, but
        // pinned to its origin when an agent opened the active tab). It still
        // grounds on the visible page via `label`.
        const discussionTab =
          tabs.find((t) => t.id === discussionId) ?? activeTab;
        // The active (visible) tab's 1-based strip ordinal — what the linked
        // agent and the user call "tab N".
        const activeN =
          tabs.findIndex((t) => t.id === activeId) + 1 || null;
        // No switcher of its own any more: the dock's context strip is the one
        // place in the app that says which conversation you are in.
        const chatPanel = (
          <div className="flex flex-col h-full min-h-0">
            <div className="flex-1 min-h-0">
              {chatTab === "list" ? (
                <Suspense fallback={<div className="h-full" />}>
                  <BrowseList
                    key={`${discussionTab.browseId}:${listReloadKey}`}
                    browseId={discussionTab.browseId}
                    source={{ url: discussionTab.url, title: discussionTab.title }}
                    capturePage={capturePage}
                    onLocate={refineLocator}
                    onClose={() => setChatHere({ open: false })}
                    onSendToDrafter={onSendToDrafter}
                    onSendToRedline={onSendToRedline}
                    onListChanged={(exists) =>
                      setListedTabs((prev) => {
                        if (!!prev[discussionTab.browseId] === exists) return prev;
                        const next = { ...prev };
                        if (exists) next[discussionTab.browseId] = true;
                        else delete next[discussionTab.browseId];
                        return next;
                      })
                    }
                    // `💬` on an item: the page agent already grounds on the
                    // live page and can read the repo, so it is the right
                    // colleague — this needs no backend of its own.
                    onDiscussItem={(quoted) => {
                      setChatSeed({ text: quoted, nonce: Date.now() });
                      setChatHere({ open: true, pill: "page" });
                    }}
                  />
                </Suspense>
              ) : chatTab === "linked" ? (
                linked.activeLinked ? (
                  <LinkedChat
                    key={linked.activeLinked.linkedId}
                    linked={linked.activeLinked}
                    tab={{
                      label: `browser-${activeId}`,
                      n: activeN,
                      browseId: activeTab.browseId,
                      url: activeTab.url,
                      title: activeTab.title,
                    }}
                    projectDir={projectDir}
                    onClose={() => setChatHere({ open: false })}
                    onOpenLink={(url) => openTab(url)}
                    onSendToRedline={onSendToRedline}
                    onSendToDrafter={onSendToDrafter}
                  />
                ) : (
                  <LinkedEmptyState
                    onStart={() => void linked.startLinked()}
                    onContinueFromTab={() => void continueTabAsLinked(discussionTab)}
                    tabBrowseId={discussionTab.browseId}
                    tabTitle={discussionTab.title}
                  />
                )
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
                  tandem={tandem}
                  anchoredFromTitle={
                    discussionTab.id !== activeId ? discussionTab.title : undefined
                  }
                  onClose={() => setChatHere({ open: false })}
                  onOpenLink={(url) => openTab(url)}
                  onSendToRedline={onSendToRedline}
                  onSendToDrafter={onSendToDrafter}
                  seed={chatSeed}
                  onSeedConsumed={() => setChatSeed(null)}
                  onAddToList={
                    // Offered only once the tab HAS a list: `browse_list_add`
                    // refuses an orphan item, so without one the button could
                    // only ever fail.
                    listedTabs[discussionTab.browseId]
                      ? (body) =>
                          invoke("browse_list_add", {
                            browseId: discussionTab.browseId,
                            kind: "note",
                            body,
                          }).then(
                            () => true,
                            (e: unknown) => {
                              console.error("browse_list_add failed", e);
                              return false;
                            },
                          )
                      : undefined
                  }
                  onContinueAsLinked={() => void continueTabAsLinked(discussionTab)}
                  linkedExists={linked.linkedSessions.length > 0}
                  onOpenExistingLinked={() => {
                    if (linked.activeLinkedId === null && linked.linkedSessions[0]) {
                      linked.resumeLinked(linked.linkedSessions[0].linkedId);
                    }
                    setChatHere({ pill: "linked" });
                  }}
                  onAddToMission={
                    mission.activeMission
                      ? (body) =>
                          // Returns whether the pin reached the DB, so the
                          // button can say "Pin failed" instead of lying.
                          mission.addFinding({
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


/** Shown in the Linked tab before a linked discussion is created. When the
 *  current tab already has a page discussion going, the PRIMARY action is to
 *  continue that chat as the linked one (a fork — the tab chat is kept);
 *  starting empty stays available beneath it. */
function LinkedEmptyState({
  onStart,
  onContinueFromTab,
  tabBrowseId,
  tabTitle,
}: {
  onStart: () => void;
  onContinueFromTab?: () => void;
  tabBrowseId?: string;
  tabTitle?: string;
}) {
  // Only offer the continuation when there is a conversation to carry.
  const [tabHasThread, setTabHasThread] = useState(false);
  useEffect(() => {
    setTabHasThread(false);
    if (!tabBrowseId || !onContinueFromTab) return;
    let alive = true;
    void invoke<unknown[]>("get_browse_thread", { browseId: tabBrowseId })
      .then((rows) => {
        if (alive) setTabHasThread(rows.length > 0);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabBrowseId]);
  return (
    <div className="flex flex-col items-center justify-center h-full gap-3 px-6 text-center">
      <Link2 size={28} strokeWidth={1.5} style={{ color: "var(--color-ink-muted)" }} />
      <p style={{ fontSize: "12px", color: "var(--color-ink-muted)", lineHeight: 1.5 }}>
        A linked discussion is one conversation that follows you across every tab.
        Switch tabs and keep talking — it carries the thread and checks in with a
        tab's own discussion when it needs to go deep.
      </p>
      {tabHasThread && onContinueFromTab && (
        <button
          type="button"
          onClick={onContinueFromTab}
          className="rounded px-3 py-1.5 font-medium"
          style={{ fontSize: "12px", background: "var(--color-info)", color: "var(--color-on-accent)" }}
        >
          Continue {tabTitle ? `“${tabTitle}”` : "this tab's chat"} as Linked
        </button>
      )}
      <button
        type="button"
        onClick={onStart}
        className="rounded px-3 py-1.5 font-medium"
        style={
          tabHasThread && onContinueFromTab
            ? {
                fontSize: "12px",
                background: "var(--color-paper)",
                color: "var(--color-ink)",
                border: "1px solid var(--color-rule)",
              }
            : {
                fontSize: "12px",
                background: "var(--color-info)",
                color: "var(--color-on-accent)",
              }
        }
      >
        Start a linked discussion
      </button>
    </div>
  );
}

/** Shown in the Mission tab when no mission is active yet. */
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

/** Memoized: one of the center-pane surfaces that used to reconcile on
 *  every frame of a divider drag. */
export const BrowserPane = memo(BrowserPaneBase);
