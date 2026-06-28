// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Window } from "@tauri-apps/api/window";
import { Webview } from "@tauri-apps/api/webview";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { usePersistedState } from "../theme/usePersistedState";
import { useMenuOverlay } from "./menuOverlay";
import { ScrapePanel } from "./ScrapePanel";
import {
  clipFilename,
  composeClipNote,
  dedupeFilename,
} from "../lib/obsidianClip";
import {
  existingNoteNames,
  getObsidianConfig,
  pickFolder,
  saveNote,
  setObsidianConfig,
  vaultDir,
  vaultNotePath,
} from "../lib/obsidian";
import {
  migrateSchema,
  type ScrapeResult,
  type ScrapeSchema,
} from "../lib/scrapeSchema";
import { runScrapeSchema } from "../lib/scrapeKernel";
import { BUILTIN_SCHEMAS } from "../lib/scrapePresets";
import {
  composeScrapeJson,
  dedupeJsonFilename,
  scrapeFilename,
} from "../lib/scrapeOutput";

// A native child webview is an OS-level layer painted on top of the React DOM —
// it does not flow inline. So this component renders an invisible placeholder
// ("slot") and syncs the *active* tab's webview position/size to that slot's
// bounding rect. Each tab is its own native child webview (label `browser-<id>`):
// they stay alive in the background (sessions/scroll preserved, and the future
// AI layer can scrape several in parallel), with only the active one shown.
// Unlike an <iframe>, a real child webview loads any site (no X-Frame-Options
// blocking) and is scriptable from Rust via webview.eval(...).
const HOME = "https://www.google.com";
const MAX_TABS = 10;
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

interface Tab {
  id: string;
  /** Native webview label — `browser-${id}`. */
  label: string;
  url: string;
  /** Display label for the tab strip (derived host). */
  title: string;
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
  /** Called with the saved path after a page is clipped or a scrape is saved. */
  onSaved?: (path: string) => void;
  /** Active file-explorer folder, if one is open — offered as a one-click
   *  "Save to project" target for scrape JSON. */
  projectDir?: string | null;
}

/** A page scraped from the live DOM, ready to compose into a note. */
interface ClipDraft {
  url: string;
  title: string;
  /** Selection-or-body text the note will carry. */
  body: string;
  /** Editable note filename (no extension). */
  filename: string;
  /** Vault-relative subfolder for the clip. */
  subdir: string;
  /** User's context note. */
  contextNote: string;
  /** Absolute vault root the note will be written under. */
  vaultPath: string;
}

const hostnameOf = (u: string): string => {
  try {
    return new URL(u).hostname || u;
  } catch {
    return u;
  }
};

const normalizeUrl = (raw: string): string => {
  const next = raw.trim();
  if (!next) return next;
  return /^[a-z]+:\/\//i.test(next) ? next : "https://" + next;
};

export function BrowserPane({
  onClose,
  visible = true,
  onSaved,
  projectDir = null,
}: BrowserPaneProps) {
  const slotRef = useRef<HTMLDivElement | null>(null);
  // id → live Webview handle. Kept in a ref (not state) because these are
  // native resources we create/destroy imperatively, not render outputs.
  const wvMapRef = useRef<Map<string, Webview>>(new Map());
  const creatingRef = useRef<Set<string>>(new Set());
  const seqRef = useRef(1);
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

  const [tabs, setTabs] = useState<Tab[]>(() => [
    { id: "t0", label: "browser-t0", url: HOME, title: hostnameOf(HOME) },
  ]);
  const [activeId, setActiveId] = useState("t0");
  const [addr, setAddr] = useState(HOME);
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
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  const activeUrl = tabs.find((t) => t.id === activeId)?.url ?? "";
  const activeUrlRef = useRef(activeUrl);
  activeUrlRef.current = activeUrl;
  const isBookmarked = bookmarks.some((b) => b.url === activeUrl);

  // Save-to-Obsidian: a scraped draft (modal open) plus busy/error flags. While
  // the modal is open, useMenuOverlay hides the native webview so the HTML modal
  // — which can't otherwise overlay the OS-composited webview — shows through.
  const [clip, setClip] = useState<ClipDraft | null>(null);
  const [clipBusy, setClipBusy] = useState(false);
  const [clipError, setClipError] = useState<string | null>(null);

  // Schema-driven scrape: the editable schema JSON is the source of truth; the
  // panel previews the structured result and saves it as JSON to a project
  // folder. Like the clip modal, opening it flips useMenuOverlay so the HTML
  // panel shows through over the OS-composited webview. Custom schemas and the
  // remembered output folder persist across sessions — the slot a future
  // fork-authored schema will land in.
  const [scrapeOpen, setScrapeOpen] = useState(false);
  const [scrapeText, setScrapeText] = useState(() =>
    JSON.stringify(BUILTIN_SCHEMAS[0], null, 2),
  );
  const [scrapeResult, setScrapeResult] = useState<ScrapeResult | null>(null);
  const [scrapeBusy, setScrapeBusy] = useState(false);
  const [scrapeError, setScrapeError] = useState<string | null>(null);
  const [customSchemas, setCustomSchemas] = usePersistedState<ScrapeSchema[]>(
    "redline.browser.scrapeSchemas",
    [],
  );
  const [scrapeOutputDir, setScrapeOutputDir] = usePersistedState<string | null>(
    "redline.scrape.outputDir",
    null,
  );
  useMenuOverlay(clip !== null || scrapeOpen);

  // Parse the editor text once per render: a valid schema is what Run/Save use;
  // a parse/validate failure becomes an inline error and disables Run.
  let parsedSchema: ScrapeSchema | null = null;
  let schemaError: string | null = null;
  try {
    parsedSchema = migrateSchema(JSON.parse(scrapeText));
  } catch (e) {
    schemaError = String(e);
  }

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
      const wv = new Webview(win, tab.label, {
        url: tab.url,
        x: Math.round(r?.left ?? 0),
        y: Math.round(r?.top ?? 0),
        width: Math.max(1, Math.round(r?.width ?? 800)),
        height: Math.max(1, Math.round(r?.height ?? 600)),
        acceptFirstMouse: true,
        userAgent: SAFARI_UA,
      });
      await new Promise<void>((resolve, reject) => {
        wv.once("tauri://created", () => resolve());
        wv.once("tauri://error", (e) => reject(e));
      });
      // Native-only: turn on two-finger back/forward swipe (off by default).
      void invoke("browser_enable_gestures", { label: tab.label }).catch(
        () => {},
      );
      // Native-only: let macOS resize this webview with the window (smooth
      // fullscreen/resize instead of laggy per-frame IPC repositioning).
      void invoke("browser_enable_autoresize", { label: tab.label }).catch(
        () => {},
      );
      return wv;
    },
    [],
  );

  // Reconcile native webviews against the tab list: create missing, close
  // orphaned. Creation is async and guarded against StrictMode double-mount.
  useEffect(() => {
    const win = Window.getCurrent();
    for (const tab of tabs) {
      if (wvMapRef.current.has(tab.id) || creatingRef.current.has(tab.id)) {
        continue;
      }
      creatingRef.current.add(tab.id);
      ensureTab(tab, win)
        .then((wv) => {
          creatingRef.current.delete(tab.id);
          // Tab was closed while we were creating — discard.
          if (!tabsRef.current.some((t) => t.id === tab.id)) {
            void wv.close().catch(() => {});
            return;
          }
          wvMapRef.current.set(tab.id, wv);
          // Carry the active view filter onto the freshly created tab so new
          // tabs match the others (the user script makes it survive navigation).
          if (viewModeRef.current !== "none") {
            void invoke("browser_set_view", {
              label: tab.label,
              css: cssForView(viewModeRef.current),
            }).catch(() => {});
          }
          if (tab.id === activeIdRef.current) {
            lastRectRef.current = null; // newly active webview — apply bounds
            syncBounds();
          } else void wv.hide();
        })
        .catch((e) => {
          creatingRef.current.delete(tab.id);
          console.error("browser tab webview failed to create", e);
        });
    }
    for (const [id, wv] of [...wvMapRef.current]) {
      if (!tabs.some((t) => t.id === id)) {
        wvMapRef.current.delete(id);
        void wv.close().catch(() => {});
      }
    }
  }, [tabs, ensureTab, syncBounds]);

  // On tab switch: hide the others, reflect the active URL in the bar, show it.
  useEffect(() => {
    for (const [id, wv] of wvMapRef.current) {
      if (id !== activeId) void wv.hide();
    }
    const t = tabsRef.current.find((x) => x.id === activeId);
    if (t) setAddr(t.url);
    lastRectRef.current = null; // different webview — force a position/size apply
    syncBounds();
  }, [activeId, syncBounds]);

  // React to overlay visibility changes over the pane.
  useEffect(() => {
    syncBounds();
  }, [visible, syncBounds]);

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
        setTabs((ts) =>
          ts.map((t) =>
            t.id === id && t.url !== url
              ? { ...t, url, title: hostnameOf(url) }
              : t,
          ),
        );
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
          void wv.close().catch(() => {});
        }
      }
    })();

    // The slot only moves on pane/window resize (ResizeObserver + window
    // resize cover those). A capture-phase scroll listener fired on every
    // unrelated scroll in the app and churned native setPosition/setSize for
    // nothing, so it's intentionally not registered.
    const onWin = () => scheduleSync();
    const ro = new ResizeObserver(scheduleSync);
    if (slotRef.current) ro.observe(slotRef.current);
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
      ro.disconnect();
      window.removeEventListener("resize", onWin);
      trailing.forEach(clearTimeout);
      unResized?.();
      const map = wvMapRef.current;
      pendingTeardown = window.setTimeout(() => {
        pendingTeardown = 0;
        for (const [, wv] of map) void wv.close().catch(() => {});
        map.clear();
      }, TEARDOWN_GRACE_MS);
    };
  }, [scheduleSync]);

  const openTab = (url: string = HOME) => {
    if (tabsRef.current.length >= MAX_TABS) return;
    const id = `t${seqRef.current++}`;
    const tab: Tab = { id, label: `browser-${id}`, url, title: hostnameOf(url) };
    setTabs((ts) => [...ts, tab]);
    setActiveId(id);
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
    setTabs(remaining);
  };

  const navigate = (raw: string, id: string = activeIdRef.current) => {
    const url = normalizeUrl(raw);
    if (!url) return;
    setTabs((ts) =>
      ts.map((t) =>
        t.id === id ? { ...t, url, title: hostnameOf(url) } : t,
      ),
    );
    if (id === activeIdRef.current) setAddr(url);
    void invoke("browser_navigate", { label: `browser-${id}`, url }).catch((e) =>
      console.error("browser_navigate failed", e),
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

  // Scrape the active page and open the clip modal. Ensures a vault is
  // configured first (picking one if not), so the modal always has a target.
  const openClip = async () => {
    setClipError(null);
    try {
      let cfg = await getObsidianConfig();
      if (!cfg.vaultPath) {
        const picked = await pickFolder("Choose your Obsidian vault");
        if (!picked) return;
        await setObsidianConfig(picked, cfg.clippingsSubdir);
        cfg = { ...cfg, vaultPath: picked };
      }
      const raw = await invoke<string>("browser_scrape", {
        label: `browser-${activeIdRef.current}`,
      });
      const page = JSON.parse(raw) as {
        url: string;
        title: string;
        selection: string;
        body: string;
      };
      const now = new Date();
      setClip({
        url: page.url || activeUrlRef.current,
        title: page.title || hostnameOf(page.url || activeUrlRef.current),
        // Prefer an active selection; fall back to the full page text.
        body: page.selection.trim() ? page.selection : page.body,
        filename: clipFilename(
          page.title || hostnameOf(page.url || activeUrlRef.current),
          now,
        ),
        subdir: cfg.clippingsSubdir,
        contextNote: "",
        vaultPath: cfg.vaultPath as string,
      });
    } catch (e) {
      setClipError(String(e));
      console.error("browser_scrape failed", e);
    }
  };

  const saveClip = async () => {
    if (!clip) return;
    setClipBusy(true);
    setClipError(null);
    try {
      const dir = vaultDir(clip.vaultPath, clip.subdir);
      const existing = await existingNoteNames(dir);
      const base = clipFilename(clip.filename, new Date());
      const unique = dedupeFilename(base, existing);
      const content = composeClipNote({
        url: clip.url,
        title: clip.title,
        body: clip.body,
        contextNote: clip.contextNote,
        savedDate: new Date(),
      });
      const path = vaultNotePath(clip.vaultPath, clip.subdir, unique);
      const saved = await saveNote(path, content);
      setClip(null);
      onSaved?.(saved);
    } catch (e) {
      setClipError(String(e));
      console.error("save clip failed", e);
    } finally {
      setClipBusy(false);
    }
  };

  // Run the current schema against the active tab via the static kernel. Capture
  // the active tab at call time (the panel is modal, so it can't change under us).
  const runScrape = async () => {
    if (!parsedSchema) return;
    setScrapeBusy(true);
    setScrapeError(null);
    try {
      const res = await runScrapeSchema(
        `browser-${activeIdRef.current}`,
        parsedSchema,
      );
      setScrapeResult(res);
      if (!res.ok) setScrapeError(res.error ?? "scrape failed");
    } catch (e) {
      setScrapeError(String(e));
      console.error("runScrape failed", e);
    } finally {
      setScrapeBusy(false);
    }
  };

  // Persist the current schema for reuse (dedup by name — re-saving replaces).
  const saveSchema = () => {
    if (!parsedSchema) return;
    const schema = parsedSchema;
    setCustomSchemas((list) => [
      ...list.filter((s) => s.name !== schema.name),
      schema,
    ]);
  };

  // Resolve the target folder for a JSON save. "project" uses the open explorer
  // folder; "default" uses the remembered folder (falling back to a picker when
  // none is set yet); "pick" always prompts. A fresh pick is remembered as the
  // default, mirroring the vault picker.
  const resolveScrapeDir = async (
    target: "default" | "pick" | "project",
  ): Promise<string | null> => {
    if (target === "project" && projectDir) return projectDir;
    if (target === "default" && scrapeOutputDir) return scrapeOutputDir;
    const picked = await pickFolder("Choose a folder to save the scrape JSON");
    if (picked) setScrapeOutputDir(picked);
    return picked;
  };

  const saveScrapeJson = async (target: "default" | "pick" | "project") => {
    if (!scrapeResult?.ok) return;
    setScrapeBusy(true);
    setScrapeError(null);
    try {
      const dir = await resolveScrapeDir(target);
      if (!dir) return;
      const existing = await existingNoteNames(dir);
      const base = scrapeFilename(
        scrapeResult.schemaName,
        scrapeResult.url || activeUrlRef.current,
        new Date(),
      );
      const unique = dedupeJsonFilename(base, existing);
      const content = composeScrapeJson(scrapeResult);
      const saved = await saveNote(`${dir}/${unique}.json`, content);
      onSaved?.(saved);
    } catch (e) {
      setScrapeError(String(e));
      console.error("save scrape json failed", e);
    } finally {
      setScrapeBusy(false);
    }
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
      {/* Tab strip */}
      <div
        className="flex items-center gap-1 px-2 pt-2"
        style={{ background: "var(--color-bg-elevated)" }}
      >
        {tabs.map((tab) => {
          const active = tab.id === activeId;
          return (
            <div
              key={tab.id}
              onClick={() => setActiveId(tab.id)}
              title={tab.url}
              className="flex items-center gap-1.5 rounded-t-md cursor-pointer"
              style={{
                maxWidth: "180px",
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
        <button
          type="button"
          style={chromeBtn}
          title="Scrape page (structured → JSON)"
          aria-label="Scrape page"
          onClick={() => {
            setScrapeResult(null);
            setScrapeError(null);
            setScrapeOpen(true);
          }}
        >
          ⛏
        </button>
        <button
          type="button"
          style={chromeBtn}
          title="Save page to Obsidian"
          aria-label="Save page to Obsidian"
          onClick={() => void openClip()}
        >
          📥
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

      {/* The active tab's native webview is positioned to cover this rect. */}
      <div
        ref={slotRef}
        className="flex-1 relative"
        style={{ background: "var(--color-paper)" }}
      >
        {clip && (
          <ClipModal
            clip={clip}
            busy={clipBusy}
            error={clipError}
            onChange={(patch) =>
              setClip((c) => (c ? { ...c, ...patch } : c))
            }
            onCancel={() => {
              setClip(null);
              setClipError(null);
            }}
            onSave={() => void saveClip()}
          />
        )}
        {scrapeOpen && (
          <ScrapePanel
            presets={BUILTIN_SCHEMAS}
            customSchemas={customSchemas}
            schemaText={scrapeText}
            schemaError={schemaError}
            result={scrapeResult}
            busy={scrapeBusy}
            error={scrapeError}
            projectDir={projectDir}
            defaultDir={scrapeOutputDir}
            onPickSchema={(s) => {
              setScrapeText(JSON.stringify(s, null, 2));
              setScrapeResult(null);
              setScrapeError(null);
            }}
            onChangeText={setScrapeText}
            onRun={() => void runScrape()}
            onSaveSchema={saveSchema}
            onSaveJson={(target) => void saveScrapeJson(target)}
            onCancel={() => {
              setScrapeOpen(false);
              setScrapeError(null);
            }}
          />
        )}
      </div>
    </div>
  );
}

// The clip dialog. Rendered as HTML inside the slot — visible because opening it
// flips useMenuOverlay, which hides the native webview underneath.
function ClipModal({
  clip,
  busy,
  error,
  onChange,
  onCancel,
  onSave,
}: {
  clip: ClipDraft;
  busy: boolean;
  error: string | null;
  onChange: (patch: Partial<ClipDraft>) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const labelStyle: React.CSSProperties = {
    fontSize: "11px",
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    color: "var(--color-ink-muted)",
  };
  const inputStyle: React.CSSProperties = {
    fontSize: "13px",
    border: "1px solid var(--color-rule)",
    background: "var(--color-paper)",
    color: "var(--color-ink)",
    borderRadius: "4px",
    padding: "6px 8px",
    width: "100%",
  };
  return (
    <div
      className="absolute inset-0 flex items-start justify-center overflow-auto"
      style={{ background: "color-mix(in srgb, var(--color-paper) 70%, transparent)" }}
    >
      <div
        className="rl-thin-scroll-y flex flex-col gap-3 m-6 p-5"
        style={{
          width: "min(560px, 92%)",
          maxHeight: "calc(100% - 48px)",
          overflowY: "auto",
          background: "var(--color-bg-elevated)",
          border: "1px solid var(--color-rule)",
          borderRadius: "8px",
          boxShadow: "0 8px 30px rgba(0,0,0,0.3)",
        }}
      >
        <div
          className="font-mono"
          style={{ fontSize: "13px", color: "var(--color-ink)" }}
        >
          Save page to Obsidian
        </div>
        <div className="truncate" style={{ fontSize: "11px", color: "var(--color-ink-muted)" }} title={clip.url}>
          {clip.url}
        </div>

        <label className="flex flex-col gap-1">
          <span style={labelStyle}>Note name</span>
          <input
            value={clip.filename}
            onChange={(e) => onChange({ filename: e.target.value })}
            spellCheck={false}
            autoFocus
            style={inputStyle}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span style={labelStyle}>Subfolder (in vault)</span>
          <input
            value={clip.subdir}
            onChange={(e) => onChange({ subdir: e.target.value })}
            spellCheck={false}
            placeholder="Web Clippings"
            style={inputStyle}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span style={labelStyle}>Context note (optional)</span>
          <textarea
            value={clip.contextNote}
            onChange={(e) => onChange({ contextNote: e.target.value })}
            rows={3}
            placeholder="Why you're saving this…"
            style={{ ...inputStyle, resize: "vertical", lineHeight: 1.5 }}
          />
        </label>

        {error && (
          <div style={{ fontSize: "12px", color: "var(--color-danger, #c0392b)" }}>
            {error}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-sm px-3 py-1"
            style={{
              fontSize: "12px",
              border: "1px solid var(--color-rule)",
              background: "var(--color-bg-elevated)",
              color: "var(--color-ink)",
              cursor: busy ? "default" : "pointer",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={busy || !clip.filename.trim()}
            className="rounded-sm px-3 py-1"
            style={{
              fontSize: "12px",
              border: "1px solid var(--color-rule)",
              background: "var(--color-anchor-bg)",
              color: "var(--color-anchor-text)",
              cursor: busy || !clip.filename.trim() ? "default" : "pointer",
              opacity: busy || !clip.filename.trim() ? 0.6 : 1,
            }}
          >
            {busy ? "Saving…" : "Save to vault"}
          </button>
        </div>
      </div>
    </div>
  );
}
