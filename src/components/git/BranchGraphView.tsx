// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
// Branches: every branch as a horizontal rail, time running left to right.
// Rail names sit in a sticky gutter on the left, tip chips at each rail's
// newest commit, a faint date axis along the top. The canvas is virtualized by
// the visible column and row range and pages 500 commits at a time as the
// viewport nears the oldest loaded commit. Selecting a commit lights up its
// ancestors, softens its descendants, dims the rest, and opens the commit
// detail drawer (the same detail, files and diff History shows).
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
// Icons are limited to ones other chunks already share: a lucide icon only this
// chunk and some other lazy chunk use becomes its own chunk, and every new chunk
// name lands in the boot entry's preload map.
import { ChevronRight, Cloud, Crosshair, GitBranch, Tag, X, ZoomIn, ZoomOut } from "lucide-react";
import { usePersistedState } from "../../theme/usePersistedState";
import { fitViewport, layoutRails, lineage, neighbor, rowClear, type EdgeRoute, type Rail, type RailEdge } from "../../lib/git/rails";
import type { GitCommit, GitRefDecoration } from "../../lib/git/types";
import { shortSha } from "./api";
import { CommitDetailPane, formatDate } from "./HistoryView";
import { branchMenu, commitMenu, remoteMenu, tagMenu } from "./menus";
import type { GitActions } from "./actions";
import type { GitRepository } from "./useGitRepository";
import type { MenuItem, useContextMenu } from "./ui";

const BRANCH_PAGE = 500;
const GUTTER = 196;
const AXIS_H = 26;
const ROW_H = 34;
const BASE_COL = 26;
const PAD_L = 44;
const PAD_R = 260;
const PAD_T = 8;
const PAD_B = 24;
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 3;
const FALLBACK_SIZE = { w: 1200, h: 640 };
/** "Fit branches": px kept before the oldest fork and after the newest commit
 *  (tip chips), the smallest clickable spacing, and the largest fitted zoom. */
const FIT_LEAD = 18;
const FIT_TAIL = 170;
const MIN_SPACING = 8;
const MAX_FIT_ZOOM = 1;

interface Viewport {
  left: number;
  top: number;
  zoom: number;
}

type Menu = ReturnType<typeof useContextMenu>;

export interface BranchGraphViewProps {
  git: GitRepository;
  actions: GitActions;
  menu: Menu;
  /** A sha the sidebar asked to show: panned to and selected. */
  reveal: { sha: string; nonce: number } | null;
  onShowInHistory: (sha: string) => void;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const lane = (color: number) => `var(--rl-git-lane-${color})`;

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
function relativeDate(seconds: number): string {
  const diff = seconds - Date.now() / 1000;
  const abs = Math.abs(diff);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [["year", 31_536_000], ["month", 2_592_000], ["week", 604_800], ["day", 86_400], ["hour", 3600], ["minute", 60]];
  for (const [unit, size] of units) if (abs >= size) return relative.format(Math.round(diff / size), unit);
  return "just now";
}
const axisDay = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const axisYear = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });

function edgePath(edge: RailEdge, x1: number, y1: number, x2: number, y2: number, colW: number): string {
  const route: EdgeRoute = edge.route;
  if (edge.kind === "stub") {
    if (edge.parentIndex === 0) return `M${x2} ${y2}H${x1}`;
    const len = Math.min(colW * 1.2, 22);
    return `M${x2} ${y2}L${x2 - len} ${y2 + ROW_H * 0.4}`;
  }
  if (route === "straight") return `M${x1} ${y1}L${x2} ${y2}`;
  const d = Math.min(x2 - x1, clamp(colW, 14, 40));
  if (route === "parent") return `M${x1} ${y1}C${x1 + d * 0.55} ${y1} ${x1 + d * 0.45} ${y2} ${x1 + d} ${y2}H${x2}`;
  if (route === "child") return `M${x1} ${y1}H${x2 - d}C${x2 - d * 0.45} ${y1} ${x2 - d * 0.55} ${y2} ${x2} ${y2}`;
  const mid = (x1 + x2) / 2;
  return `M${x1} ${y1}C${mid} ${y1} ${mid} ${y2} ${x2} ${y2}`;
}

type Chip = GitRefDecoration & { synced?: string };
/** Ref chips at a commit: the checked-out branch first, then locals, remotes,
 *  tags. A remote branch sitting on its same-named local branch folds into
 *  that branch's chip as an in-sync mark. */
function visibleRefs(refs: GitRefDecoration[], showRemotes: boolean, showTags: boolean): Chip[] {
  const order = { head: 0, local: 1, remote: 2, tag: 3 } as const;
  const shown: Chip[] = refs.filter((r) => (r.kind !== "remote" || showRemotes) && (r.kind !== "tag" || showTags)).map((r) => ({ ...r }));
  const locals = new Map(shown.filter((r) => r.kind === "head" || r.kind === "local").map((r) => [r.name, r]));
  const out = shown.filter((r) => {
    if (r.kind !== "remote") return true;
    const local = locals.get(r.name.slice(r.name.indexOf("/") + 1));
    if (!local || local.synced) return true;
    local.synced = r.name;
    return false;
  });
  return out.sort((a, b) => order[a.kind] - order[b.kind]);
}
const chipWidth = (refs: Chip[]) => refs.reduce((w, r) => w + r.name.length * 6.4 + (r.kind === "tag" || r.kind === "head" ? 26 : 16) + (r.synced ? 15 : 0) + 4, 0);

export default function BranchGraphView({ git, actions, menu, reveal, onShowInHistory }: BranchGraphViewProps) {
  const { api, status, refs } = git;
  const [showRemotes, setShowRemotes] = usePersistedState("redline.git.branches.remotes", true);
  const [showTags, setShowTags] = usePersistedState("redline.git.branches.tags", true);
  const [drawerHeight, setDrawerHeight] = usePersistedState("redline.git.branches.drawer", 300, { debounceMs: 200 });
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [exhausted, setExhausted] = useState(false);
  const [settled, setSettled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [vp, setVp] = useState<Viewport>({ left: 0, top: 0, zoom: 1 });
  const [size, setSize] = useState(FALLBACK_SIZE);
  const [hover, setHover] = useState<{ sha: string; x: number; y: number } | null>(null);

  const canvasRef = useRef<HTMLDivElement>(null);
  const loading = useRef(false);
  const loadedCount = useRef(0);
  loadedCount.current = commits.length;
  const anchor = useRef<{ sha: string; offset: number } | null>(null);
  const initialized = useRef(false);
  const pendingReveal = useRef<{ sha: string; pages: number } | null>(null);
  const initialRevealNonce = useRef(reveal?.nonce ?? 0);

  const headSha = status?.head ?? null;
  // Re-read the log only when HEAD or a ref moves (not on every poll).
  const refsKey = useMemo(
    () => JSON.stringify([headSha, refs?.current, refs?.local.map((b) => [b.name, b.sha]), refs?.remote.map((b) => [b.name, b.sha]), refs?.tags.map((t) => [t.name, t.sha])]),
    [headSha, refs],
  );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stableRefs = useMemo(() => refs, [refsKey]);
  const layout = useMemo(() => layoutRails(commits, stableRefs, { head: headSha, showRemotes, showTags }), [commits, stableRefs, headSha, showRemotes, showTags]);

  // Geometry the event handlers read without re-binding.
  const geo = useRef({ layout, size, vp });
  geo.current = { layout, size, vp };

  const clampVp = useCallback((v: Viewport): Viewport => {
    const { layout: l, size: s } = geo.current;
    const zoom = clamp(v.zoom, MIN_ZOOM, MAX_ZOOM);
    const colW = BASE_COL * zoom;
    const gw = Math.max(1, s.w - GUTTER);
    const gh = Math.max(1, s.h - AXIS_H);
    const cw = PAD_L + Math.max(0, l.columns.length - 1) * colW + PAD_R;
    const ch = PAD_T + l.rows.length * ROW_H + PAD_B;
    return { zoom, left: clamp(v.left, 0, Math.max(0, cw - gw)), top: clamp(v.top, 0, Math.max(0, ch - gh)) };
  }, []);
  const update = useCallback((fn: (v: Viewport) => Viewport) => setVp((v) => clampVp(fn(v))), [clampVp]);
  /** The "fit branches" viewport: every named rail from its fork to the newest
   *  commit, all rails from the top; squeezed ranges keep MIN_SPACING and stay
   *  on the newest commits. */
  const fitted = useCallback((): Viewport => {
    const { layout: l, size: s } = geo.current;
    const { zoom, left } = fitViewport({
      from: l.fit.from,
      to: l.fit.to,
      width: s.w - GUTTER,
      padLeft: PAD_L,
      leadIn: FIT_LEAD,
      tail: FIT_TAIL,
      baseColumn: BASE_COL,
      minSpacing: MIN_SPACING,
      maxZoom: MAX_FIT_ZOOM,
    });
    return clampVp({ zoom, left, top: 0 });
  }, [clampVp]);

  /** Remember which commit sits where on screen so a re-layout keeps it there. */
  const captureAnchor = useCallback(() => {
    const { layout: l, size: s, vp: v } = geo.current;
    if (l.columns.length === 0) return;
    const colW = BASE_COL * v.zoom;
    const gw = s.w - GUTTER;
    const screenX = (x: number) => GUTTER + PAD_L + x * colW - v.left;
    const sel = selectedRef.current ? l.nodes.get(selectedRef.current) : undefined;
    let sha: string;
    if (sel && screenX(sel.x) >= GUTTER && screenX(sel.x) <= s.w) sha = sel.sha;
    else sha = l.columns[clamp(Math.round((v.left + gw / 2 - PAD_L) / colW), 0, l.columns.length - 1)];
    anchor.current = { sha, offset: screenX(l.nodes.get(sha)!.x) };
  }, []);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  // A repo switch starts over: fresh commits, no selection, a new fit.
  const lastApi = useRef(api);
  useLayoutEffect(() => {
    if (lastApi.current === api) return;
    lastApi.current = api;
    initialized.current = false;
    loadedCount.current = 0;
    anchor.current = null;
    pendingReveal.current = null;
    setCommits([]);
    setSettled(false);
    setExhausted(false);
    setSelected(null);
    setDrawerOpen(false);
  }, [api]);

  // ---- Loading
  useEffect(() => {
    let live = true;
    loading.current = true;
    const pages = Math.max(1, Math.ceil(loadedCount.current / BRANCH_PAGE));
    (async () => {
      const out: GitCommit[] = [];
      let done = false;
      for (let i = 0; i < pages && !done; i++) {
        const page = await api.log(i * BRANCH_PAGE, BRANCH_PAGE, true);
        out.push(...page);
        if (page.length < BRANCH_PAGE) done = true;
      }
      if (!live) return;
      captureAnchor();
      setCommits(out);
      setExhausted(done);
      setSettled(true);
      setError(null);
    })()
      .catch((e) => live && setError(String(e)))
      .finally(() => {
        if (live) loading.current = false;
      });
    return () => {
      live = false;
      loading.current = false;
    };
  }, [api, refsKey, captureAnchor]);

  const loadMore = useCallback(() => {
    if (loading.current || exhausted) return;
    loading.current = true;
    const skip = loadedCount.current;
    api.log(skip, BRANCH_PAGE, true).then(
      (page) => {
        captureAnchor();
        setCommits((current) => {
          if (current.length !== skip) return current;
          const seen = new Set(current.map((c) => c.sha));
          return [...current, ...page.filter((c) => !seen.has(c.sha))];
        });
        if (page.length < BRANCH_PAGE) setExhausted(true);
      },
      (e) => setError(String(e)),
    ).finally(() => {
      loading.current = false;
    });
  }, [api, exhausted, captureAnchor]);

  // ---- Size
  useLayoutEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      setSize(w > 0 && h > 0 ? { w, h } : FALLBACK_SIZE);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const colW = BASE_COL * vp.zoom;
  const sx = useCallback((x: number) => GUTTER + PAD_L + x * colW - vp.left, [colW, vp.left]);
  const sy = useCallback((row: number) => AXIS_H + PAD_T + row * ROW_H + ROW_H / 2 - vp.top, [vp.top]);

  const centerOn = useCallback(
    (sha: string, at = 0.5) => {
      const node = geo.current.layout.nodes.get(sha);
      if (!node) return;
      const s = geo.current.size;
      update((v) => {
        const cw = BASE_COL * v.zoom;
        return { ...v, left: PAD_L + node.x * cw - (s.w - GUTTER) * at, top: PAD_T + node.row * ROW_H + ROW_H / 2 - (s.h - AXIS_H) / 2 };
      });
    },
    [update],
  );
  const ensureVisible = useCallback(
    (sha: string) => {
      const node = geo.current.layout.nodes.get(sha);
      if (!node) return;
      const s = geo.current.size;
      update((v) => {
        const cw = BASE_COL * v.zoom;
        const wx = PAD_L + node.x * cw;
        const wy = PAD_T + node.row * ROW_H;
        const gw = s.w - GUTTER;
        const gh = s.h - AXIS_H;
        const margin = Math.min(80, gw / 4);
        let { left, top } = v;
        if (wx < left + margin) left = wx - margin;
        else if (wx > left + gw - margin) left = wx - gw + margin;
        if (wy < top) top = wy - 4;
        else if (wy + ROW_H > top + gh) top = wy + ROW_H - gh + 4;
        return { ...v, left, top };
      });
    },
    [update],
  );

  // ---- Re-layout: keep the anchored commit in place, the first layout opens on the newest commits.
  useLayoutEffect(() => {
    if (layout.columns.length === 0) return;
    if (!initialized.current) {
      initialized.current = true;
      anchor.current = null;
      setVp(fitted());
      return;
    }
    const a = anchor.current;
    anchor.current = null;
    if (a) {
      const node = layout.nodes.get(a.sha);
      if (node) setVp((v) => clampVp({ ...v, left: GUTTER + PAD_L + node.x * BASE_COL * v.zoom - a.offset }));
    } else setVp((v) => clampVp(v));
    if (selectedRef.current && !layout.nodes.has(selectedRef.current) && !commits.some((c) => c.sha === selectedRef.current)) {
      setSelected(null);
      setDrawerOpen(false);
    }
  }, [layout, clampVp, fitted, commits]);
  useLayoutEffect(() => setVp((v) => clampVp(v)), [size, clampVp]);

  // Page in older commits as the viewport nears the oldest loaded one.
  useEffect(() => {
    if (!settled || exhausted || commits.length === 0) return;
    if (vp.left < (size.w - GUTTER) * 1.5) loadMore();
  }, [vp.left, settled, exhausted, commits.length, size.w, loadMore]);

  // ---- Selection
  const select = useCallback((sha: string | null, opts: { drawer?: boolean; center?: boolean } = {}) => {
    setSelected(sha);
    if (sha === null) {
      setDrawerOpen(false);
      return;
    }
    if (opts.drawer) setDrawerOpen(true);
    if (opts.center) centerOn(sha, 0.6);
    else ensureVisible(sha);
  }, [centerOn, ensureVisible]);

  // Sidebar reveal: pan to the ref's tip and select it, paging it in if needed.
  useEffect(() => {
    if (!reveal || reveal.nonce === initialRevealNonce.current) return;
    pendingReveal.current = { sha: reveal.sha, pages: 0 };
  }, [reveal]);
  useEffect(() => {
    const pending = pendingReveal.current;
    if (!pending || !settled) return;
    if (layout.nodes.has(pending.sha)) {
      pendingReveal.current = null;
      select(pending.sha, { drawer: true, center: true });
    } else if (commits.some((c) => c.sha === pending.sha)) {
      // Loaded but hidden by a toggle: show everything.
      setShowRemotes(true);
      setShowTags(true);
    } else if (!exhausted && pending.pages < 20) {
      if (!loading.current) {
        pending.pages++;
        loadMore();
      }
    } else pendingReveal.current = null;
  });

  const lit = useMemo(() => {
    if (!selected || !layout.nodes.has(selected)) return null;
    const { ancestors, descendants } = lineage(layout, selected);
    ancestors.add(selected);
    descendants.add(selected);
    return { ancestors, descendants };
  }, [layout, selected]);
  const nodeState = (sha: string): "sel" | "anc" | "desc" | "dim" | undefined => {
    if (!lit) return undefined;
    if (sha === selected) return "sel";
    if (lit.ancestors.has(sha)) return "anc";
    if (lit.descendants.has(sha)) return "desc";
    return "dim";
  };
  const edgeState = (edge: RailEdge): "anc" | "desc" | "dim" | undefined => {
    if (!lit) return undefined;
    if (lit.ancestors.has(edge.child) && (edge.parent === null || lit.ancestors.has(edge.parent))) return "anc";
    if (edge.parent !== null && lit.descendants.has(edge.child) && lit.descendants.has(edge.parent)) return "desc";
    return "dim";
  };

  // ---- Hit testing
  const hitTest = useCallback((clientX: number, clientY: number): string | null => {
    const el = canvasRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    if (px < GUTTER || py < AXIS_H) return null;
    const { layout: l, vp: v } = geo.current;
    const cw = BASE_COL * v.zoom;
    const rowF = (py - AXIS_H - PAD_T + v.top - ROW_H / 2) / ROW_H;
    const colF = (px - GUTTER - PAD_L + v.left) / cw;
    let best: string | null = null;
    let bestD = 11;
    for (const row of [Math.floor(rowF), Math.ceil(rowF)]) {
      const r = l.rows[row];
      if (!r) continue;
      const dy = Math.abs(rowF - row) * ROW_H;
      // nearest column on this row
      let lo = 0;
      let hi = r.xs.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (r.xs[mid] < colF) lo = mid + 1;
        else hi = mid;
      }
      for (const i of [lo - 1, lo]) {
        if (i < 0 || i >= r.xs.length) continue;
        const d = Math.hypot((r.xs[i] - colF) * cw, dy);
        if (d < bestD) {
          bestD = d;
          best = r.shas[i];
        }
      }
    }
    return best;
  }, []);
  const shaFromEvent = (event: { target: EventTarget | null; clientX: number; clientY: number }) => {
    const target = event.target instanceof Element ? event.target.closest("[data-sha]") : null;
    return target?.getAttribute("data-sha") ?? hitTest(event.clientX, event.clientY);
  };

  // ---- Wheel, pinch, drag
  const zoomAt = useCallback((screenX: number, next: (z: number) => number) => {
    update((v) => {
      const zoom = clamp(next(v.zoom), MIN_ZOOM, MAX_ZOOM);
      const gx = Math.max(0, screenX - GUTTER) - PAD_L;
      const col = (v.left + gx) / (BASE_COL * v.zoom);
      return { ...v, zoom, left: col * BASE_COL * zoom - gx };
    });
  }, [update]);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      setHover(null);
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
      const dx = event.deltaX * unit;
      const dy = event.deltaY * unit;
      const rect = el.getBoundingClientRect();
      if (event.ctrlKey || event.metaKey) {
        const step = clamp(dy, -40, 40);
        zoomAt(event.clientX - rect.left, (z) => z * Math.exp(-step * 0.01));
      } else if (event.shiftKey) update((v) => ({ ...v, top: v.top + (dy || dx) }));
      else if (Math.abs(dx) > Math.abs(dy)) update((v) => ({ ...v, left: v.left + dx }));
      else update((v) => ({ ...v, left: v.left + dy }));
    };
    // WebKit pinch arrives as gesture events rather than ctrl+wheel.
    let gestureStart = 1;
    const onGestureStart = (event: Event) => {
      event.preventDefault();
      gestureStart = geo.current.vp.zoom;
    };
    const onGestureChange = (event: Event) => {
      event.preventDefault();
      const e = event as Event & { scale?: number; clientX?: number };
      const rect = el.getBoundingClientRect();
      zoomAt((e.clientX ?? rect.left + rect.width / 2) - rect.left, () => gestureStart * (e.scale ?? 1));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("gesturestart", onGestureStart);
    el.addEventListener("gesturechange", onGestureChange);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("gesturestart", onGestureStart);
      el.removeEventListener("gesturechange", onGestureChange);
    };
  }, [update, zoomAt]);

  const drag = useRef<{ x: number; y: number; left: number; top: number; moved: boolean; id: number } | null>(null);
  const suppressClick = useRef(false);
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    drag.current = { x: event.clientX, y: event.clientY, left: vp.left, top: vp.top, moved: false, id: event.pointerId };
    suppressClick.current = false;
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d) {
      const dx = event.clientX - d.x;
      const dy = event.clientY - d.y;
      if (!d.moved && Math.hypot(dx, dy) > 4) {
        d.moved = true;
        setHover(null);
        canvasRef.current?.setPointerCapture?.(d.id);
      }
      if (d.moved) update((v) => ({ ...v, left: d.left - dx, top: d.top - dy }));
      return;
    }
    const sha = hitTest(event.clientX, event.clientY);
    const rect = canvasRef.current!.getBoundingClientRect();
    setHover(sha ? { sha, x: event.clientX - rect.left, y: event.clientY - rect.top } : null);
  };
  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    if (d?.moved) {
      suppressClick.current = true;
      if (canvasRef.current?.hasPointerCapture?.(event.pointerId)) canvasRef.current.releasePointerCapture(event.pointerId);
    }
  };
  const onCanvasClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    if (event.target instanceof Element && event.target.closest(".rl-bg-gutter, .rl-bg-axis")) return;
    canvasRef.current?.focus({ preventScroll: true });
    const sha = shaFromEvent(event);
    select(sha, { drawer: sha !== null });
  };

  const openCommitMenu = (event: { clientX: number; clientY: number; preventDefault?: () => void }, sha: string) => {
    const node = layout.nodes.get(sha);
    if (!node) return;
    setSelected(sha);
    menu.open(event, commitMenu(node.commit, actions, status));
  };
  const railMenu = (rail: Rail): MenuItem[] => {
    const current = refs?.current ?? null;
    const tipSha = rail.tip;
    if (rail.kind === "local" && rail.name) return branchMenu(rail.name, tipSha, rail.current, current, actions, onShowInHistory);
    if (rail.kind === "remote" && rail.name) return remoteMenu(rail.name, tipSha, current, actions, onShowInHistory);
    if (rail.kind === "tag" && rail.name) return tagMenu(rail.name, tipSha, actions, onShowInHistory);
    return commitMenu(layout.nodes.get(tipSha)!.commit, actions, status);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const dirs: Record<string, "left" | "right" | "up" | "down"> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };
    if (dirs[event.key]) {
      event.preventDefault();
      if (!selected || !layout.nodes.has(selected)) {
        const start = headSha && layout.nodes.has(headSha) ? headSha : layout.columns[layout.columns.length - 1];
        if (start) select(start);
        return;
      }
      const next = neighbor(layout, selected, dirs[event.key]);
      if (next) select(next);
      else if (dirs[event.key] === "left" && !exhausted) loadMore();
    } else if (event.key === "Enter" && selected) {
      event.preventDefault();
      setDrawerOpen(true);
    } else if (event.key === "Escape") {
      if (selected || drawerOpen) {
        event.preventDefault();
        select(null);
      }
    } else if ((event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) && selected && layout.nodes.has(selected)) {
      event.preventDefault();
      const node = layout.nodes.get(selected)!;
      const rect = canvasRef.current!.getBoundingClientRect();
      openCommitMenu({ clientX: rect.left + sx(node.x) + 8, clientY: rect.top + sy(node.row) + 8 }, selected);
    } else if (event.key === "=" || event.key === "+") zoomAt(size.w * 0.6, (z) => z * 1.25);
    else if (event.key === "-") zoomAt(size.w * 0.6, (z) => z / 1.25);
  };

  const closeDrawer = () => {
    setDrawerOpen(false);
    canvasRef.current?.focus({ preventScroll: true });
  };
  const jumpToHead = () => {
    if (headSha && layout.nodes.has(headSha)) select(headSha, { center: true });
  };
  const fit = () => setVp(fitted());
  const toggle = (which: "remotes" | "tags", value: boolean) => {
    captureAnchor();
    (which === "remotes" ? setShowRemotes : setShowTags)(value);
  };

  // ---- Drawer resize
  const resizing = useRef<{ y: number; h: number } | null>(null);
  const onResizeDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target instanceof Element && event.target.closest("button"))) return;
    resizing.current = { y: event.clientY, h: drawerHeight };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const onResizeMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const r = resizing.current;
    if (!r) return;
    const total = (canvasRef.current?.parentElement?.clientHeight ?? 800) || 800;
    setDrawerHeight(clamp(r.h - (event.clientY - r.y), 140, Math.max(160, total - 160)));
  };
  const onResizeUp = () => {
    resizing.current = null;
  };

  // ---- Visible window
  const gw = size.w - GUTTER;
  const c0 = Math.floor((vp.left - PAD_L) / colW) - 2;
  const c1 = Math.ceil((vp.left + gw - PAD_L) / colW) + 2;
  const r0 = Math.max(0, Math.floor((vp.top - PAD_T) / ROW_H) - 1);
  const r1 = Math.min(layout.rows.length - 1, Math.ceil((vp.top + size.h - AXIS_H - PAD_T) / ROW_H) + 1);
  const radius = clamp(colW * 0.2, 2.25, 4.5);

  const visibleNodes: string[] = [];
  for (let r = r0; r <= r1; r++) {
    const row = layout.rows[r];
    if (!row) continue;
    let lo = 0;
    let hi = row.xs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (row.xs[mid] < c0) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < row.xs.length && row.xs[i] <= c1; i++) visibleNodes.push(row.shas[i]);
  }

  // Edges batched into one path per colour and state.
  const paths = new Map<string, { color: number; state: string; kind: string; d: string[] }>();
  const mergeOut = new Set<string>();
  for (const edge of layout.edges) {
    if (edge.route === "child" && edge.parent) mergeOut.add(edge.parent);
    const xa = Math.min(edge.x1, edge.x2);
    const xb = Math.max(edge.x1, edge.x2);
    if (xb < c0 || (edge.kind !== "stub" && xa > c1)) continue;
    const ra = Math.min(edge.row1, edge.row2);
    const rb = Math.max(edge.row1, edge.row2);
    if (rb < r0 - 1 || ra > r1 + 1) continue;
    const state = edgeState(edge) ?? "";
    const kind = edge.kind === "stub" ? "stub" : edge.kind === "rail" ? "rail" : "cross";
    const key = `${edge.color}|${state}|${kind}`;
    const x1 = edge.kind === "stub" ? sx(0) - Math.min(PAD_L - 8, Math.max(colW, 18)) : sx(edge.x1);
    const d = edgePath(edge, x1, sy(edge.row1), sx(edge.x2), sy(edge.row2), colW);
    const entry = paths.get(key);
    if (entry) entry.d.push(d);
    else paths.set(key, { color: edge.color, state, kind, d: [d] });
  }

  // Date axis: a label wherever the day changes, at least ~110px apart.
  const ticks: Array<{ x: number; label: string }> = [];
  if (layout.columns.length) {
    const newestYear = new Date((layout.nodes.get(layout.columns[layout.columns.length - 1])?.commit.date ?? 0) * 1000).getFullYear();
    let lastKey = "";
    let lastX = -Infinity;
    for (let c = Math.max(0, c0); c <= Math.min(layout.columns.length - 1, c1); c++) {
      const date = new Date(layout.nodes.get(layout.columns[c])!.commit.date * 1000);
      const key = date.toDateString();
      const x = sx(c);
      if (key !== lastKey && x - lastX >= 110 && x >= GUTTER + 8) {
        ticks.push({ x, label: (date.getFullYear() === newestYear ? axisDay : axisYear).format(date) });
        lastX = x;
      }
      lastKey = key;
    }
  }

  // Ref chips: inline after the node when the row is clear, raised above it
  // otherwise. Walking newest first, a chip that would collide with a newer
  // one on the same row is left to the tooltip.
  const chips: Array<{ sha: string; shown: Chip[]; inline: boolean; x: number; y: number; state: ReturnType<typeof nodeState> }> = [];
  const occupied = new Map<string, number>();
  for (const sha of [...visibleNodes].sort((a, b) => layout.nodes.get(b)!.x - layout.nodes.get(a)!.x)) {
    const node = layout.nodes.get(sha)!;
    const shown = visibleRefs(node.commit.refs, showRemotes, showTags);
    if (shown.length === 0) continue;
    const x = sx(node.x);
    const width = chipWidth(shown);
    const inline = !mergeOut.has(sha) && rowClear(layout.rows[node.row], node.x, node.x + (width + 18) / colW);
    const start = inline ? x + radius + 7 : x - 6;
    const bucket = `${node.row}|${inline ? "i" : "r"}`;
    const limit = occupied.get(bucket) ?? Infinity;
    if (start + width * (inline ? 1 : 0.92) > limit - 4) continue;
    occupied.set(bucket, start);
    chips.push({ sha, shown, inline, x, y: sy(node.row), state: nodeState(sha) });
  }

  const hoverNode = hover ? layout.nodes.get(hover.sha) : undefined;
  const selectedNode = selected ? layout.nodes.get(selected) : undefined;
  const selectedRail = selectedNode ? selectedNode.rail : null;
  const leftEdge = sx(0) - PAD_L + 10;

  return (
    <div className="rl-bg">
      <div className="rl-git-pane-head rl-bg-head">
        <span className="rl-git-pane-title">Branches</span>
        <span className="rl-git-muted">
          {layout.columns.length.toLocaleString()}
          {exhausted ? "" : "+"} commits · {layout.rails.filter((r) => r.name !== null).length} rails
          {layout.hidden > 0 ? ` · ${layout.hidden.toLocaleString()} hidden` : ""}
        </span>
        <span className="rl-git-spacer" />
        <label className="rl-git-toggle">
          <input type="checkbox" checked={showRemotes} onChange={(e) => toggle("remotes", e.target.checked)} /> Remote branches
        </label>
        <label className="rl-git-toggle">
          <input type="checkbox" checked={showTags} onChange={(e) => toggle("tags", e.target.checked)} /> Tags
        </label>
        <span className="rl-bg-sep" />
        <button type="button" className="rl-git-icon-btn" title="Jump to HEAD" aria-label="Jump to HEAD" disabled={!headSha || !layout.nodes.has(headSha)} onClick={jumpToHead}>
          <Crosshair size={14} />
        </button>
        <button type="button" className="rl-git-icon-btn" title="Fit branches" aria-label="Fit" onClick={fit}>
          <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M3 8V5a2 2 0 0 1 2-2h3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3M8 12h8M8 12l2.5-2.5M8 12l2.5 2.5M16 12l-2.5-2.5M16 12l-2.5 2.5" />
          </svg>
        </button>
        <button type="button" className="rl-git-icon-btn" title="Zoom out (−)" aria-label="Zoom out" onClick={() => zoomAt(size.w * 0.6, (z) => z / 1.4)}>
          <ZoomOut size={14} />
        </button>
        <button type="button" className="rl-git-icon-btn" title="Zoom in (+)" aria-label="Zoom in" onClick={() => zoomAt(size.w * 0.6, (z) => z * 1.4)}>
          <ZoomIn size={14} />
        </button>
      </div>
      {error && <div className="rl-git-banner rl-git-banner-error">{error}</div>}
      <div
        ref={canvasRef}
        className="rl-bg-canvas"
        tabIndex={0}
        role="application"
        aria-label="Branch graph"
        aria-roledescription="branch graph"
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerLeave={() => setHover(null)}
        onClick={onCanvasClick}
        onContextMenu={(event) => {
          if (event.target instanceof Element && event.target.closest(".rl-bg-gutter")) return;
          const sha = shaFromEvent(event);
          if (sha) {
            event.preventDefault();
            openCommitMenu(event, sha);
          }
        }}
      >
        <svg className="rl-bg-svg" width={size.w} height={size.h} aria-hidden>
          {ticks.map((t) => (
            <line key={`g${t.x}`} className="rl-bg-grid" x1={t.x} x2={t.x} y1={AXIS_H} y2={size.h} />
          ))}
          {selectedRail !== null && layout.rails[selectedRail] && (
            <rect className="rl-bg-row-band" x={GUTTER} y={sy(layout.rails[selectedRail].row) - ROW_H / 2} width={gw} height={ROW_H} />
          )}
          {!exhausted && layout.columns.length > 0 && leftEdge > GUTTER - 40 && (
            <g className="rl-bg-more">
              <line x1={leftEdge} x2={leftEdge} y1={AXIS_H} y2={size.h} />
            </g>
          )}
          {[...paths.values()].map((p) => (
            <path
              key={`${p.color}|${p.state}|${p.kind}`}
              className="rl-bg-edge"
              data-kind={p.kind}
              data-state={p.state || undefined}
              d={p.d.join("")}
              style={{ stroke: lane(p.color) }}
            />
          ))}
          {visibleNodes.map((sha) => {
            const node = layout.nodes.get(sha)!;
            const x = sx(node.x);
            const y = sy(node.row);
            const state = nodeState(sha);
            const head = sha === headSha;
            return (
              <g key={sha} className="rl-bg-node" data-sha={sha} data-state={state} data-head={head ? "" : undefined} style={{ ["--lane" as string]: lane(node.color) }}>
                {state === "sel" && <circle className="rl-bg-halo" cx={x} cy={y} r={radius + 6} />}
                {head && <circle className="rl-bg-head-ring" cx={x} cy={y} r={radius + 3.5} />}
                <circle className={node.merge ? "rl-bg-dot rl-bg-dot-merge" : "rl-bg-dot"} cx={x} cy={y} r={node.merge ? radius - 0.25 : radius} style={radius < 3 ? { strokeWidth: node.merge ? 1.25 : 0.6 } : undefined} />
                <circle className="rl-bg-hit" cx={x} cy={y} r={Math.max(radius + 4, 8)} />
              </g>
            );
          })}
        </svg>

        <div className="rl-bg-chips" aria-hidden>
          {chips.map(({ sha, shown, inline, x, y, state }) => (
            <span
              key={sha}
              className="rl-git-chips rl-bg-chipset"
              data-sha={sha}
              data-state={state}
              data-inline={inline ? "" : undefined}
              style={inline ? { left: x + radius + 7, top: y } : { left: x - 6, top: y - 15 }}
            >
              {shown.map((ref) => (
                <span key={`${ref.kind}:${ref.name}`} className="rl-git-chip" data-kind={ref.kind}>
                  {ref.kind === "tag" ? "◆ " : ref.kind === "head" ? "● " : ""}
                  {ref.name}
                  {ref.synced && <Cloud size={10} className="rl-bg-synced" aria-label={`in sync with ${ref.synced}`} />}
                </span>
              ))}
            </span>
          ))}
        </div>

        <div className="rl-bg-axis" aria-hidden>
          {ticks.map((t) => (
            <span key={t.x} className="rl-bg-tick" style={{ left: t.x }}>
              {t.label}
            </span>
          ))}
          {!exhausted && layout.columns.length > 0 && leftEdge > GUTTER && <span className="rl-bg-tick rl-bg-tick-more" style={{ left: leftEdge }}>older…</span>}
        </div>

        <div className="rl-bg-gutter" role="list" aria-label="Rails">
          <div className="rl-bg-gutter-head">
            <span>Branch</span>
          </div>
          {layout.rows.slice(r0, r1 + 1).map((row) => {
            if (row.rail === null) return null;
            const rail = layout.rails[row.rail];
            const top = sy(row.index) - ROW_H / 2;
            const inView = rail.maxX + 1 >= c0 && rail.minX - 1 <= c1;
            return (
              <button
                key={`${rail.kind}:${rail.name}`}
                type="button"
                role="listitem"
                className="rl-bg-label"
                data-current={rail.current ? "" : undefined}
                data-active={selectedRail === rail.id ? "" : undefined}
                data-away={inView ? undefined : ""}
                style={{ top, ["--lane" as string]: lane(rail.color) }}
                title={[rail.name, ...rail.aliases].join(" · ")}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  select(rail.tip, { drawer: true, center: true });
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setSelected(rail.tip);
                  menu.open(e, railMenu(rail));
                }}
              >
                <span className="rl-bg-label-bar" />
                {rail.kind === "remote" ? <Cloud size={12} /> : rail.kind === "tag" ? <Tag size={12} /> : rail.kind === "head" ? <Crosshair size={12} /> : <GitBranch size={12} />}
                <span className="rl-bg-label-name">{rail.name}</span>
                {rail.aliases.length > 0 && <span className="rl-bg-label-more">+{rail.aliases.length}</span>}
                {!inView && (rail.maxX + 1 < c0 ? <ChevronRight size={12} className="rl-bg-label-dir" data-dir="left" aria-label="off to the left" /> : <ChevronRight size={12} className="rl-bg-label-dir" aria-label="off to the right" />)}
              </button>
            );
          })}
        </div>

        {settled && layout.columns.length === 0 && !error && <div className="rl-git-empty rl-bg-empty">No commits yet.</div>}

        {hoverNode && !drag.current?.moved && (
          <div
            className="rl-bg-tip"
            role="tooltip"
            style={{
              left: Math.min(hover!.x + 14, size.w - 330),
              top: hover!.y + 16 > size.h - 120 ? hover!.y - 110 : hover!.y + 16,
            }}
          >
            <div className="rl-bg-tip-subject">{hoverNode.commit.subject}</div>
            <div className="rl-bg-tip-meta">
              <span className="rl-git-mono">{shortSha(hoverNode.sha)}</span> · {hoverNode.commit.authorName}
            </div>
            <div className="rl-bg-tip-meta">
              {relativeDate(hoverNode.commit.date)} · {formatDate(hoverNode.commit.date)}
            </div>
            {hoverNode.commit.refs.length > 0 && (
              <div className="rl-bg-tip-refs">
                {hoverNode.commit.refs.map((r) => (
                  <span key={`${r.kind}:${r.name}`} className="rl-git-chip" data-kind={r.kind}>{r.name}</span>
                ))}
              </div>
            )}
          </div>
        )}
        <div className="rl-bg-sr" aria-live="polite">
          {selectedNode ? `${shortSha(selectedNode.sha)} ${selectedNode.commit.subject}` : ""}
        </div>
      </div>

      {drawerOpen && selectedNode && (
        <div
          className="rl-bg-drawer"
          style={{ height: drawerHeight }}
          onKeyDown={(event) => {
            if (event.key === "Escape" && !event.defaultPrevented) {
              event.preventDefault();
              closeDrawer();
            }
          }}
        >
          <div className="rl-bg-drawer-bar" onPointerDown={onResizeDown} onPointerMove={onResizeMove} onPointerUp={onResizeUp} onPointerCancel={onResizeUp} title="Drag to resize">
            <span className="rl-git-mono rl-git-muted">{shortSha(selectedNode.sha)}</span>
            <span className="rl-bg-drawer-title">{selectedNode.commit.subject}</span>
            <span className="rl-git-spacer" />
            <button type="button" className="rl-git-icon-btn" aria-label="Close commit details" title="Close (the graph keeps its selection)" onClick={closeDrawer}>
              <X size={14} />
            </button>
          </div>
          <CommitDetailPane
            git={git}
            commit={selectedNode.commit}
            onSelect={(sha) => {
              if (layout.nodes.has(sha)) select(sha, { center: true });
            }}
          />
        </div>
      )}
    </div>
  );
}

