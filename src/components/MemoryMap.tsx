// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { usePersistedState } from "../theme/usePersistedState";
import {
  DEFAULT_EDGE_TOGGLES,
  EDGE_KINDS,
  EDGE_LABEL,
  edgeHitTest,
  hitTest,
  layoutMap,
  visibleEdges,
  type EdgeKind,
  type MapEdge,
  type MemoryMapData,
  type PlacedNode,
} from "../lib/memoryMap";
import type { TimelineFocus } from "../lib/timeline";

// The Map tab (Second Brain P5) — the shape of the record, drawn under §3's
// four rules: classes and sessions only (prompts are radius, never dots, and
// the ~150 cap is stated on screen); a deterministic seeded layout so spatial
// memory works; declared, toggleable edge kinds with the derived `co-occurs`
// opt-in; and a node click that FILTERS the Timeline — the map is a
// navigational control, not a terminal artifact. Hand-rolled canvas, no graph
// library; it lives on its own tab so its cost is only paid when visible (the
// render-isolation rule).

interface MemoryMapTabProps {
  /** A node click hands the surface a Timeline focus (§3 rule 4). */
  onFocus: (f: TimelineFocus) => void;
}

/** Resolve the theme's CSS variables once per draw — the canvas can't read
 *  `var()` itself, and resolving at draw time keeps theme switches honest. */
function themeColors(): Record<string, string> {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) =>
    cs.getPropertyValue(name).trim() || fallback;
  return {
    ink: v("--color-ink", "#e6e6e6"),
    muted: v("--color-ink-muted", "#9a9a9a"),
    rule: v("--color-rule", "#3a3a3a"),
    paper: v("--color-paper", "#1c1c1c"),
    info: v("--color-info", "#4f8cff"),
  };
}

/** Edge hues: the declared kinds borrow the ledger vocabulary's colors
 *  (`session_link` blue for lineage, `supersede` rust for the decision chain,
 *  `observation` teal for the derived co-occurrence). */
const EDGE_COLOR: Record<EdgeKind, string> = {
  contains: "", // the theme's rule color, resolved at draw time
  lineage: "#7a8fb0",
  supersedes: "#c65d21",
  co_occurs: "#3f9e8f",
};

const NODE_COLOR: Record<string, string> = {
  session: "#7a8fb0",
  thread: "#3aa0c0",
};

function chipStyle(active: boolean): React.CSSProperties {
  return {
    fontSize: "10px",
    padding: "2px 7px",
    borderRadius: "999px",
    cursor: "pointer",
    whiteSpace: "nowrap",
    border: active
      ? "1px solid color-mix(in srgb, var(--color-info) 55%, var(--color-rule))"
      : "1px solid var(--color-rule)",
    background: active
      ? "color-mix(in srgb, var(--color-info) 14%, transparent)"
      : "transparent",
    color: "var(--color-ink)",
  };
}

export function MemoryMapTab({ onFocus }: MemoryMapTabProps) {
  const [data, setData] = useState<MemoryMapData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toggles, setToggles] = usePersistedState<Record<EdgeKind, boolean>>(
    "redline.memory.mapEdges",
    DEFAULT_EDGE_TOGGLES,
  );
  const [hover, setHover] = useState<PlacedNode | null>(null);
  const [hoverEdge, setHoverEdge] = useState<MapEdge | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await invoke<MemoryMapData>("memory_map"));
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  // Load once, then follow the record — coalesced behind a trailing debounce
  // (every prompt fires ledger-changed; the map only needs the settled state).
  useEffect(() => {
    void load();
    let timer: number | undefined;
    const later = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void load(), 800);
    };
    const un1 = listen("ledger-changed", later);
    const un2 = listen("classmem-changed", later);
    return () => {
      window.clearTimeout(timer);
      void un1.then((f) => f());
      void un2.then((f) => f());
    };
  }, [load]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() =>
      setSize({ w: el.clientWidth, h: el.clientHeight }),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const layout = useMemo(
    () => (data && size.w > 0 && size.h > 0 ? layoutMap(data, size.w, size.h) : null),
    [data, size],
  );
  const byId = useMemo(
    () => new Map((layout?.nodes ?? []).map((n) => [n.id, n])),
    [layout],
  );
  const edges = useMemo(
    () =>
      data && layout
        ? visibleEdges(data.edges, toggles, new Set(byId.keys()))
        : [],
    [data, layout, toggles, byId],
  );
  const edgeCounts = useMemo(() => {
    const counts = { contains: 0, lineage: 0, supersedes: 0, co_occurs: 0 };
    for (const e of data?.edges ?? []) counts[e.kind] += 1;
    return counts;
  }, [data]);

  // --- draw ---------------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !layout) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(layout.width * dpr);
    canvas.height = Math.round(layout.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, layout.width, layout.height);
    const theme = themeColors();

    // Edges under nodes; the hovered one thickens and states its meaning.
    for (const e of edges) {
      const a = byId.get(e.from);
      const b = byId.get(e.to);
      if (!a || !b) continue;
      const isHover = hoverEdge === e;
      ctx.strokeStyle = e.kind === "contains" ? theme.rule : EDGE_COLOR[e.kind];
      ctx.globalAlpha = isHover ? 1 : e.kind === "contains" ? 0.9 : 0.55;
      ctx.lineWidth =
        (e.kind === "co_occurs" ? Math.min(3.5, 1 + Math.log2(e.weight + 1)) : 1.2) +
        (isHover ? 0.8 : 0);
      ctx.setLineDash(
        e.kind === "co_occurs" ? [3, 4] : e.kind === "lineage" ? [6, 4] : [],
      );
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.setLineDash([]);
      // The decision chain is directed: an arrowhead at the superseding end.
      if (e.kind === "supersedes") {
        const ang = Math.atan2(b.y - a.y, b.x - a.x);
        const tipX = b.x - Math.cos(ang) * (b.r + 3);
        const tipY = b.y - Math.sin(ang) * (b.r + 3);
        ctx.fillStyle = EDGE_COLOR.supersedes;
        ctx.beginPath();
        ctx.moveTo(tipX, tipY);
        ctx.lineTo(tipX - Math.cos(ang - 0.4) * 7, tipY - Math.sin(ang - 0.4) * 7);
        ctx.lineTo(tipX - Math.cos(ang + 0.4) * 7, tipY - Math.sin(ang + 0.4) * 7);
        ctx.closePath();
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;

    // Nodes: classes as discs (digests hollow — a gist, not a live branch),
    // sessions/threads as rounded squares. Pins get the gold ring.
    for (const n of layout.nodes) {
      const isHover = hover?.id === n.id;
      const color =
        n.kind === "class" || n.kind === "digest" ? theme.info : NODE_COLOR[n.kind];
      ctx.lineWidth = isHover ? 2 : 1.2;
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      if (n.kind === "session" || n.kind === "thread") {
        const s = n.r;
        ctx.globalAlpha = isHover ? 0.5 : 0.28;
        ctx.beginPath();
        ctx.roundRect(n.x - s, n.y - s, s * 2, s * 2, 3);
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.stroke();
      } else {
        ctx.globalAlpha = n.kind === "digest" ? 0.12 : isHover ? 0.6 : 0.35;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r, 0, 2 * Math.PI);
        ctx.fill();
        ctx.globalAlpha = 1;
        if (n.kind === "digest") ctx.setLineDash([3, 3]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      if (n.pinned) {
        ctx.strokeStyle = "#d0a52f";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r + 3, 0, 2 * Math.PI);
        ctx.stroke();
      }
    }

    // Labels for the heavy nodes (and always the hovered one), with a paper
    // halo so they survive edge crossings in any theme.
    ctx.font = "10px ui-sans-serif, system-ui, sans-serif";
    ctx.textAlign = "center";
    for (const n of layout.nodes) {
      const isHover = hover?.id === n.id;
      if (n.r < 10 && !isHover) continue;
      const label = n.label.length > 28 ? `${n.label.slice(0, 27)}…` : n.label;
      const ly = n.y + n.r + 12;
      ctx.lineWidth = 3;
      ctx.strokeStyle = theme.paper;
      ctx.strokeText(label, n.x, ly);
      ctx.fillStyle = isHover ? theme.ink : theme.muted;
      ctx.fillText(label, n.x, ly);
    }
  }, [layout, edges, byId, hover, hoverEdge]);

  // --- pointer ------------------------------------------------------------
  const onMove = useCallback(
    (ev: React.MouseEvent<HTMLCanvasElement>) => {
      if (!layout) return;
      const rect = ev.currentTarget.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const y = ev.clientY - rect.top;
      const n = hitTest(layout.nodes, x, y);
      setHover(n);
      setHoverEdge(n ? null : edgeHitTest(edges, byId, x, y));
    },
    [layout, edges, byId],
  );

  const onClick = useCallback(() => {
    if (!hover) return;
    if (hover.classNodeId) onFocus({ classNodeId: hover.classNodeId, label: hover.label });
    else if (hover.sessionId) onFocus({ sessionId: hover.sessionId, label: hover.label });
    else if (hover.browseId) onFocus({ browseId: hover.browseId, label: hover.label });
    else if (hover.threadId) onFocus({ threadId: hover.threadId, label: hover.label });
  }, [hover, onFocus]);

  const title = hover
    ? `${hover.label} — ${hover.kind} · ${hover.mass} ${
        hover.kind === "class" || hover.kind === "digest" ? "filed" : "message"
      }${hover.mass === 1 ? "" : "s"} · click to filter the Timeline`
    : hoverEdge
      ? `${EDGE_LABEL[hoverEdge.kind]}${hoverEdge.basis ? ` — ${hoverEdge.basis}` : ""}${
          hoverEdge.kind === "co_occurs" ? " (derived)" : ""
        }`
      : "";

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      {/* Edge toggles — declared semantics, the derived one labeled as such. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "8px 12px",
          borderBottom: "1px solid var(--color-rule)",
          flexShrink: 0,
        }}
      >
        {EDGE_KINDS.map((k) => (
          <button
            key={k}
            type="button"
            className="font-sans"
            onClick={() => setToggles((prev) => ({ ...prev, [k]: !prev[k] }))}
            aria-pressed={toggles[k]}
            title={
              k === "co_occurs"
                ? "Derived edge: classes sharing sessions or a project while filed apart — the merge/promote signal"
                : `Show ${EDGE_LABEL[k].toLowerCase()} edges`
            }
            style={chipStyle(toggles[k])}
          >
            <span
              aria-hidden
              style={{
                display: "inline-block",
                width: 14,
                borderTop: `2px ${k === "co_occurs" ? "dotted" : k === "lineage" ? "dashed" : "solid"} ${
                  k === "contains" ? "var(--color-rule)" : EDGE_COLOR[k]
                }`,
                verticalAlign: "middle",
                marginRight: 5,
              }}
            />
            {EDGE_LABEL[k]}
            {k === "co_occurs" && " (derived)"}
            <span style={{ color: "var(--color-ink-muted)", marginLeft: 4 }}>
              {edgeCounts[k]}
            </span>
          </button>
        ))}
        <div style={{ flex: 1 }} />
        {layout && (
          <span className="font-sans" style={{ fontSize: 11, color: "var(--color-ink-muted)" }}>
            {layout.nodes.length} node{layout.nodes.length === 1 ? "" : "s"}
            {layout.hidden > 0 && ` · ${layout.hidden} hidden (heaviest ${layout.nodes.length} shown)`}
          </span>
        )}
      </div>

      {error && (
        <div
          className="font-sans"
          style={{ padding: "8px 12px", fontSize: 12, color: "var(--color-danger, #d0454c)" }}
        >
          {error}
        </div>
      )}

      <div ref={wrapRef} style={{ flex: 1, minHeight: 0, position: "relative" }}>
        {data && data.nodes.length === 0 ? (
          <div
            className="font-sans"
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--color-ink-muted)",
              fontSize: 12,
              padding: 24,
              textAlign: "center",
            }}
          >
            Nothing to map yet — the Map draws accepted classes and linked
            sessions. Run Organize in the Catalog and accept what it proposes.
          </div>
        ) : (
          <canvas
            ref={canvasRef}
            title={title}
            onMouseMove={onMove}
            onMouseLeave={() => {
              setHover(null);
              setHoverEdge(null);
            }}
            onClick={onClick}
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              cursor: hover ? "pointer" : "default",
            }}
          />
        )}
      </div>
    </div>
  );
}
