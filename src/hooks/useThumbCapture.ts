// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// Drives the Localhost dashboard's thumbnail capture.
//
// The constraint that shapes everything: WebKit can only snapshot a webview
// that is genuinely on screen (a hidden NSView renders blank), and a native
// webview paints OVER the React DOM rather than inside it. So there is no way
// to capture a page invisibly. Rather than fight that, the capture leans into
// it — ONE webview is parked exactly over the card's thumbnail rect, the page
// loads there in full view, and the frame freezes into a PNG. What would be an
// awkward artifact reads as deliberate: the card boots, then settles.
//
// Consequences that the rest of this file exists to manage:
//   * Captures are strictly SERIAL. Two webviews would mean two rectangles of
//     the grid hijacked at once.
//   * Every await is a cancellation point. The user can switch surfaces or
//     scroll the card away mid-capture, and the parked webview must not be left
//     sitting over unrelated UI.
//   * A card whose rect isn't on screen is DEFERRED, not failed — it comes back
//     when the grid settles, without burning its failure cooldown.

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { Webview } from "@tauri-apps/api/webview";
import { Window } from "@tauri-apps/api/window";
import { SAFARI_UA } from "../components/BrowserPane";
import type { BinaryFile } from "../types";
import {
  calibrateScale,
  INITIAL_THUMB_SCALE,
  planCaptures,
  type ThumbEntry,
  type ThumbTarget,
} from "../lib/thumbs";

/** The single capture webview. `browser-*` so it falls under the capability
 *  file's existing webview allowance — it is outside BrowserPane's suspension
 *  machinery, but it honors the spirit: exactly one, closed when done. */
const THUMB_LABEL = "browser-thumbcap";

/** How long to wait for a page to report itself loaded before giving up. */
const READY_TIMEOUT_MS = 8000;
const READY_POLL_MS = 150;
/** Time after `readyState === "complete"` for the paints that follow it —
 *  webfonts swapping, a hero image decoding, a framework hydrating. Without it
 *  most captures are of a correct but empty-looking page. */
const SETTLE_MS = 700;
/** A card must be at least this visible to be worth parking a webview over. */
const MIN_RECT = 24;

export interface ThumbCaptureTarget extends ThumbTarget {
  url: string;
}

/** What `browser_take_thumbnail` reports back — mirrors `thumbs::ThumbShot`. */
interface ThumbShot {
  path: string;
  pixelWidth: number;
  pixelHeight: number;
}

export interface UseThumbCapture {
  /** key → data URL, for the cards to render. */
  thumbs: Map<string, string>;
  /** The card being captured right now, for its shimmer. */
  capturingKey: string | null;
  /** Cards register the element whose rect the webview should cover. */
  registerRect: (key: string, el: HTMLElement | null) => void;
  /** Force a re-capture of one card (its hover refresh button). */
  refresh: (key: string) => void;
  /** Native capture isn't available (non-macOS) — cards show placeholders and
   *  the queue stops asking. */
  unsupported: boolean;
}

/** Read a PNG off disk as a data URL. A missing file (a `thumb_path` from a
 *  previous install, a pruned key) simply yields null and the card falls back
 *  to its placeholder — never an error. */
async function readThumb(path: string): Promise<string | null> {
  try {
    const file = await invoke<BinaryFile>("read_file_base64", { path });
    return file.data ? `data:image/png;base64,${file.data}` : null;
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

/** Same-origin test used to tell "the page loaded" from "the previous page is
 *  still showing". A refused connection leaves the webview on whatever it had
 *  before, where `readyState` is happily "complete" — so the URL has to agree. */
function sameOrigin(href: string, target: string): boolean {
  try {
    return new URL(href).origin === new URL(target).origin;
  } catch {
    return false;
  }
}

export function useThumbCapture(
  targets: ThumbCaptureTarget[],
  active: boolean,
  onCaptured: (key: string, path: string) => void,
): UseThumbCapture {
  const [thumbs, setThumbs] = useState<Map<string, string>>(new Map());
  const [capturingKey, setCapturingKey] = useState<string | null>(null);
  const [unsupported, setUnsupported] = useState(false);

  // What's on disk (seeded once from thumbs_list, then kept current as we
  // capture) and when each key last failed.
  const entriesRef = useRef<Map<string, ThumbEntry>>(new Map());
  const failuresRef = useRef<Map<string, number>>(new Map());
  // Cards' DOM elements, for the rect the webview glues to.
  const rectsRef = useRef<Map<string, HTMLElement>>(new Map());
  // Serialization + cancellation. `runningRef` admits one runner; `tokenRef` is
  // bumped by anything that should abandon the one in flight.
  const runningRef = useRef(false);
  const tokenRef = useRef(0);
  const wvRef = useRef<Webview | null>(null);
  const lastRectRef = useRef<{ x: number; y: number; w: number; h: number } | null>(
    null,
  );
  const activeRef = useRef(active);
  activeRef.current = active;
  const targetsRef = useRef(targets);
  targetsRef.current = targets;
  const unsupportedRef = useRef(unsupported);
  unsupportedRef.current = unsupported;
  const onCapturedRef = useRef(onCaptured);
  onCapturedRef.current = onCaptured;
  // How much to multiply a card's CSS width by when asking for a snapshot.
  // Starts conservative and self-corrects after the first real capture — see
  // calibrateScale. A ref, not state: changing it must not re-render anything.
  const scaleRef = useRef(INITIAL_THUMB_SCALE);
  // The key currently parked over, so scroll/resize can keep the webview glued.
  const parkedKeyRef = useRef<string | null>(null);
  const rafRef = useRef(0);

  const registerRect = useCallback((key: string, el: HTMLElement | null) => {
    if (el) rectsRef.current.set(key, el);
    else rectsRef.current.delete(key);
  }, []);

  /** The on-screen rect of a card's thumb box, or null if it isn't usefully
   *  visible (unmounted, collapsed, scrolled out of the viewport). */
  const rectFor = useCallback((key: string) => {
    const el = rectsRef.current.get(key);
    if (!el || !el.isConnected) return null;
    const r = el.getBoundingClientRect();
    if (r.width < MIN_RECT || r.height < MIN_RECT) return null;
    if (
      r.bottom <= 0 ||
      r.right <= 0 ||
      r.top >= window.innerHeight ||
      r.left >= window.innerWidth
    ) {
      return null;
    }
    return {
      x: Math.round(r.left),
      y: Math.round(r.top),
      w: Math.round(r.width),
      h: Math.round(r.height),
    };
  }, []);

  /** Move the parked webview onto a rect, touching the native view only when
   *  something actually changed (redundant setPosition/setSize force WKWebView
   *  relayout — the same discipline BrowserPane's syncBounds follows). */
  const applyRect = useCallback(
    (wv: Webview, next: { x: number; y: number; w: number; h: number }) => {
      const prev = lastRectRef.current;
      if (!prev || prev.x !== next.x || prev.y !== next.y) {
        void wv.setPosition(new LogicalPosition(next.x, next.y));
      }
      if (!prev || prev.w !== next.w || prev.h !== next.h) {
        void wv.setSize(new LogicalSize(next.w, next.h));
      }
      lastRectRef.current = next;
    },
    [],
  );

  /** Get (or create) the one capture webview. */
  const ensureWebview = useCallback(
    async (rect: { x: number; y: number; w: number; h: number }) => {
      const existing = await Webview.getByLabel(THUMB_LABEL).catch(() => null);
      if (existing) {
        wvRef.current = existing;
        return existing;
      }
      const win = Window.getCurrent();
      const opts = {
        url: "about:blank",
        x: rect.x,
        y: rect.y,
        width: Math.max(1, rect.w),
        height: Math.max(1, rect.h),
        // Present as a real browser tab: a dev server that content-negotiates
        // on the UA must serve the same page it serves when you click Open.
        userAgent: SAFARI_UA,
      };
      const create = () =>
        new Promise<Webview>((resolve, reject) => {
          const w = new Webview(win, THUMB_LABEL, opts);
          w.once("tauri://created", () => resolve(w));
          w.once("tauri://error", (e) => reject(e));
        });
      try {
        wvRef.current = await create();
      } catch (firstErr) {
        // A previous webview may still be mid-teardown; the duplicate label
        // would throw. Wait for it to actually vanish, then retry once — the
        // same retry BrowserPane's ensureTab needs.
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          const still = await Webview.getByLabel(THUMB_LABEL).catch(() => null);
          if (!still) break;
          await sleep(80);
        }
        try {
          wvRef.current = await create();
        } catch {
          throw firstErr;
        }
      }
      lastRectRef.current = null;
      return wvRef.current;
    },
    [],
  );

  const hideWebview = useCallback(() => {
    parkedKeyRef.current = null;
    const wv = wvRef.current;
    if (wv) void wv.hide().catch(() => {});
  }, []);

  /** Capture one card. Returns "ok" | "failed" | "deferred" | "cancelled". */
  const captureOne = useCallback(
    async (
      key: string,
      url: string,
      token: number,
    ): Promise<"ok" | "failed" | "deferred" | "cancelled"> => {
      const cancelled = () => token !== tokenRef.current || !activeRef.current;
      const rect = rectFor(key);
      if (!rect) return "deferred";

      let wv: Webview;
      try {
        wv = await ensureWebview(rect);
      } catch {
        return "failed";
      }
      if (cancelled()) return "cancelled";

      parkedKeyRef.current = key;
      applyRect(wv, rect);
      try {
        await invoke("browser_navigate", { label: THUMB_LABEL, url });
      } catch {
        return "failed";
      }
      await wv.show().catch(() => {});
      if (cancelled()) return "cancelled";

      // Wait for the page to report itself loaded AND to actually be the page
      // we asked for.
      const deadline = Date.now() + READY_TIMEOUT_MS;
      let ready = false;
      while (Date.now() < deadline) {
        if (cancelled()) return "cancelled";
        // The card can scroll away mid-load — give up cleanly rather than
        // snapshotting a webview parked over the wrong part of the app.
        if (!rectFor(key)) return "deferred";
        try {
          const state = await invoke<string>("browser_eval_result", {
            label: THUMB_LABEL,
            script:
              "(function(){try{return document.readyState + '|' + location.href}catch(e){return 'err|'}})()",
          });
          const [readyState, href = ""] = state.split("|");
          if (readyState === "complete" && sameOrigin(href, url)) {
            ready = true;
            break;
          }
        } catch (e) {
          // The one error worth reacting to permanently: there is no native
          // snapshot path on this platform at all.
          if (String(e).includes("only supported on macOS")) {
            setUnsupported(true);
            return "failed";
          }
        }
        await sleep(READY_POLL_MS);
      }
      if (!ready) return "failed";
      if (cancelled()) return "cancelled";

      // Disarm the page. A native webview sits above every DOM element, so no
      // React overlay can shield it — in-page CSS is the only way to stop a
      // stray click landing on somebody's dev site. It doesn't affect painting,
      // so the snapshot is unchanged.
      try {
        await invoke("browser_eval", {
          label: THUMB_LABEL,
          script:
            "(function(){try{document.documentElement.style.pointerEvents='none'}catch(e){}})()",
        });
      } catch {
        /* best effort — a page that refuses this is still snapshotable */
      }

      await sleep(SETTLE_MS);
      if (cancelled()) return "cancelled";
      const stillThere = rectFor(key);
      if (!stillThere) return "deferred";

      try {
        const requested = stillThere.w * scaleRef.current;
        const shot = await invoke<ThumbShot>("browser_take_thumbnail", {
          label: THUMB_LABEL,
          key,
          width: requested,
        });
        // Learn the system's real points-to-pixels behavior from the capture
        // that just happened, so every later one is exactly display-sharp.
        scaleRef.current = calibrateScale(
          requested,
          shot.pixelWidth,
          window.devicePixelRatio || 1,
        );
        const path = shot.path;
        entriesRef.current.set(key, { key, path, modifiedMs: Date.now() });
        const dataUrl = await readThumb(path);
        if (cancelled()) return "cancelled";
        if (dataUrl) {
          setThumbs((prev) => new Map(prev).set(key, dataUrl));
        }
        onCapturedRef.current(key, path);
        return "ok";
      } catch (e) {
        if (String(e).includes("only supported on macOS")) setUnsupported(true);
        return "failed";
      }
    },
    [applyRect, ensureWebview, rectFor],
  );

  /** Drain the queue, one card at a time. */
  const runQueue = useCallback(async () => {
    if (runningRef.current) return;
    if (!activeRef.current || unsupportedRef.current) return;
    runningRef.current = true;
    const token = ++tokenRef.current;
    try {
      // Recomputed each iteration: the scan polls, so cards come and go while
      // the queue drains.
      for (;;) {
        if (token !== tokenRef.current || !activeRef.current) break;
        if (unsupportedRef.current) break;
        const queue = planCaptures(
          targetsRef.current,
          entriesRef.current,
          failuresRef.current,
          Date.now(),
        );
        const key = queue.find((k) => rectFor(k) !== null);
        if (!key) break; // nothing to do, or nothing currently on screen
        const target = targetsRef.current.find((t) => t.key === key);
        if (!target) break;
        setCapturingKey(key);
        const result = await captureOne(key, target.url, token);
        setCapturingKey(null);
        if (result === "cancelled") break;
        if (result === "failed") failuresRef.current.set(key, Date.now());
        if (result === "deferred") {
          // Don't spin on a card that keeps being out of view — leave the queue
          // and let the next scroll/scan tick re-enter.
          break;
        }
      }
    } finally {
      setCapturingKey(null);
      hideWebview();
      runningRef.current = false;
    }
  }, [captureOne, hideWebview, rectFor]);

  const runQueueRef = useRef(runQueue);
  runQueueRef.current = runQueue;

  /** Hover "refresh" on a card: clear its cooldown and its cached entry so the
   *  planner treats it as missing, then re-enter the queue. */
  const refresh = useCallback((key: string) => {
    failuresRef.current.delete(key);
    entriesRef.current.delete(key);
    void runQueueRef.current();
  }, []);

  // --- mount: seed from disk, prune what no card claims ----------------------
  useEffect(() => {
    let alive = true;
    void (async () => {
      let list: ThumbEntry[] = [];
      try {
        list = await invoke<ThumbEntry[]>("thumbs_list");
      } catch (e) {
        if (String(e).includes("only supported on macOS")) setUnsupported(true);
        return;
      }
      if (!alive) return;
      const map = new Map<string, ThumbEntry>();
      for (const e of list) map.set(e.key, e);
      entriesRef.current = map;
      // Show what we already have immediately — including for servers that are
      // currently down, whose last picture is the whole point of keeping these.
      const loaded = new Map<string, string>();
      for (const e of list) {
        const dataUrl = await readThumb(e.path);
        if (!alive) return;
        if (dataUrl) loaded.set(e.key, dataUrl);
      }
      if (!alive) return;
      setThumbs(loaded);
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Prune once the card set is known — keys no card claims are dead weight.
  const prunedRef = useRef(false);
  useEffect(() => {
    if (prunedRef.current || targets.length === 0) return;
    prunedRef.current = true;
    void invoke("thumbs_prune", {
      keepKeys: targets.map((t) => t.key),
    }).catch(() => {});
  }, [targets]);

  // --- re-enter the queue when the work or the surface changes ---------------
  useEffect(() => {
    if (!active) {
      // Abandon anything in flight and get the webview off the screen.
      tokenRef.current++;
      hideWebview();
      return;
    }
    void runQueueRef.current();
  }, [active, targets, hideWebview]);

  // --- keep the parked webview glued while the grid moves --------------------
  useEffect(() => {
    if (!active) return;
    const resync = () => {
      if (rafRef.current) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = 0;
        const key = parkedKeyRef.current;
        const wv = wvRef.current;
        if (!key || !wv) return;
        const rect = rectFor(key);
        if (!rect) {
          // Scrolled out from under the capture — stop covering whatever is
          // there now; the runner will notice and defer.
          void wv.hide().catch(() => {});
          return;
        }
        applyRect(wv, rect);
      });
    };
    // `true` so the grid's own scroll container is caught, not just the window.
    window.addEventListener("scroll", resync, true);
    window.addEventListener("resize", resync);
    return () => {
      window.removeEventListener("scroll", resync, true);
      window.removeEventListener("resize", resync);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    };
  }, [active, applyRect, rectFor]);

  // Nothing scrolls forever: after the grid settles, retry whatever deferred.
  useEffect(() => {
    if (!active) return;
    let timer = 0;
    const onSettle = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void runQueueRef.current(), 400);
    };
    window.addEventListener("scroll", onSettle, true);
    return () => {
      window.removeEventListener("scroll", onSettle, true);
      window.clearTimeout(timer);
    };
  }, [active]);

  // --- unmount: cancel and destroy ------------------------------------------
  useEffect(
    () => () => {
      tokenRef.current++;
      // browser_close routes through STOP_MEDIA_JS, so a dev page that
      // autoplayed something can't keep sounding from an invisible webview.
      void invoke("browser_close", { label: THUMB_LABEL }).catch(() => {});
      wvRef.current = null;
    },
    [],
  );

  return { thumbs, capturingKey, registerRect, refresh, unsupported };
}
