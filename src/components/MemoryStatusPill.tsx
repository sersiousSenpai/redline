// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { useMenuOverlay } from "./menuOverlay";

// The quiet ambient pill, now in header chrome (it was two clicks deep in the
// Settings dropdown before Memory became a main surface). Click opens a small
// status popover — chain state, last organize, compaction — with "Open
// Memory →" into the full surface and a quick-inspector escape hatch. It
// listens for `memory-changed` (emitted by the background keeper and the
// manual commands) and re-reads.

export interface MemoryStatus {
  live: boolean;
  itemCount: number;
  backlog: number;
  lastOrganizedTs: number | null;
  lastOrganizedSummary: string | null;
  chainOk: boolean;
  compactedCount: number;
  reclaimedBytes: number;
  lastCompactionTs: number | null;
  /** Structural proposals held awaiting human review (the escalation channel). */
  pendingProposals: number;
  /** Corpus composition — rows and bytes per role. The number that was missing:
   *  92.6% of the lake's searchable bytes were machine text and nothing
   *  reported it, so the only symptom was that search "felt wrong". */
  corpusRoles?: { role: string; rows: number; bytes: number }[];
  corpusBytes?: number;
  corpusUserBytes?: number;
  /** Which tier wrote the surviving gists. A summarizer that silently stopped
   *  running shows here as a rising `deterministic` count, instead of hiding
   *  behind a healthy-looking reclaim number. */
  keeperGistSource?: { agent: number; deterministic: number };
  /** Cold compactions that are still reversible, and what the copies cost. */
  archivedCount?: number;
  archivedBytes?: number;
  /** Ask turns that were handed a server-side prefetch, and how many of them
   *  answered without curling — the honest A/B for the one-turn design. */
  askPrefetch?: { hits: number; turns: number };
  /** The semantic index. `pending` is reported beside `chunks` so a half-built
   *  index is VISIBLE rather than silently degrading recall, and
   *  `provider: "absent"` says the arm cannot run on this machine at all —
   *  which is a fact about the machine, not about the user's history. */
  embeddings?: {
    provider: string;
    model: string | null;
    chunks: number;
    pending: number;
  };
}

/** Coarse "N ago" for the pill. Pure, so it's unit-tested. */
export function relativeTime(ts: number | null, now: number): string {
  if (!ts) return "not yet";
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/** The pill's one-line label. Pure. Held proposals outrank the ambient line —
 *  a queued destructive op must never be invisible. The ready-depth segment
 *  (`· N ready`, the work graph's unfiltered ready frontier) appends after
 *  whichever memory segment won, and hides entirely at zero. */
export function pillLabel(
  status: MemoryStatus | null,
  now: number,
  readyWork = 0,
): string {
  const base = (() => {
    if (!status) return "Memory";
    if (status.pendingProposals > 0) return `Memory · ${status.pendingProposals} to review`;
    if (status.lastOrganizedTs) return `Memory · organized ${relativeTime(status.lastOrganizedTs, now)}`;
    if (status.itemCount > 0) return `Memory · ${status.itemCount} captured`;
    return "Memory";
  })();
  return readyWork > 0 ? `${base} · ${readyWork} ready` : base;
}

export function MemoryStatusPill({
  onOpenMemory,
  onOpenInspector,
}: {
  /** Land on the Memory main surface. */
  onOpenMemory: () => void;
  /** The quick-inspector modal (Lake / Catalog / Settings). */
  onOpenInspector: () => void;
}) {
  const [status, setStatus] = useState<MemoryStatus | null>(null);
  // The work graph's unfiltered ready frontier depth — the ambient "· N
  // ready" segment. Display-only, like the pill's other segments.
  const [readyWork, setReadyWork] = useState(0);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, right: 0 });
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  // Hide the native browser webview while this menu is up (see useMenuOverlay).
  useMenuOverlay(open);

  const load = useCallback(async () => {
    try {
      setStatus(await invoke<MemoryStatus>("memory_status"));
    } catch {
      /* best-effort: the pill is ambient, never an error surface */
    }
    try {
      const graph = await invoke<{ readyIds: string[] }>("get_work_graph");
      setReadyWork(graph.readyIds.length);
    } catch {
      /* same best-effort rule: no ready count is a hidden segment, not an error */
    }
  }, []);

  useEffect(() => {
    void load();
    // Coalesce the change bursts. A browse capture emits `memory-changed` per
    // captured page, so a few seconds of browsing used to fire a status read
    // per page; the pill is ambient, and one read a second is plenty.
    let coalesce: number | undefined;
    const reload = () => {
      window.clearTimeout(coalesce);
      coalesce = window.setTimeout(() => void load(), 1_000);
    };
    const un = listen("memory-changed", reload);
    // Accepting/rejecting a held proposal emits only classmem-changed — the
    // pill's review count must follow it, not just the keeper's heartbeat.
    const unClass = listen("classmem-changed", reload);
    // A slow poll keeps the relative time honest even between keeper runs.
    const t = window.setInterval(() => void load(), 60_000);
    return () => {
      window.clearTimeout(coalesce);
      window.clearInterval(t);
      void un.then((f) => f());
      void unClass.then((f) => f());
    };
  }, [load]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const toggle = () => {
    const r = btnRef.current?.getBoundingClientRect();
    // Fixed positioning so the popover escapes any clipping ancestor (the
    // header pill sits at the top, so it always drops down).
    if (r) setPos({ top: r.bottom + 6, right: window.innerWidth - r.right });
    setOpen((v) => !v);
  };

  const now = Date.now();
  const chainBad = status != null && !status.chainOk;
  const heldOps = status != null && status.pendingProposals > 0;

  const row: React.CSSProperties = {
    display: "flex",
    justifyContent: "space-between",
    gap: 12,
    fontSize: 12,
  };
  const muted: React.CSSProperties = { color: "var(--color-ink-muted)" };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={toggle}
        title={
          status
            ? `${status.itemCount} events · ${status.backlog} awaiting organize · ${
                status.compactedCount
              } compacted · chain ${status.chainOk ? "OK" : "BROKEN"}`
            : "Open memory"
        }
        aria-label="Memory status"
        aria-expanded={open}
        className="flex items-center gap-1.5 rounded-full"
        style={{
          fontSize: "12px",
          lineHeight: 1,
          border: "1px solid var(--color-rule)",
          background: "var(--color-bg-elevated)",
          color: "var(--color-ink)",
          padding: "3px 9px",
          cursor: "pointer",
        }}
      >
        <span
          aria-hidden
          style={{
            width: 6,
            height: 6,
            borderRadius: 999,
            flex: "0 0 auto",
            // Red (broken chain) outranks amber (held ops) outranks green.
            background: chainBad ? "#d64545" : heldOps ? "#e0913a" : "#2fae66",
            boxShadow: chainBad
              ? "none"
              : heldOps
                ? "0 0 4px rgba(224,145,58,0.8)"
                : "0 0 4px rgba(47,174,102,0.8)",
          }}
        />
        <span style={{ whiteSpace: "nowrap" }}>{pillLabel(status, now, readyWork)}</span>
      </button>
      {open && (
        <div
          ref={popRef}
          className="font-sans"
          style={{
            position: "fixed",
            top: pos.top,
            right: pos.right,
            zIndex: 60,
            width: "250px",
            display: "flex",
            flexDirection: "column",
            gap: 8,
            padding: "11px 13px 12px",
            background: "var(--color-bg-elevated)",
            border: "1px solid var(--color-rule)",
            borderRadius: "8px",
            boxShadow: "0 12px 32px rgba(0,0,0,0.32)",
          }}
        >
          <div style={row}>
            <span style={muted}>Chain</span>
            <span>{status ? (status.chainOk ? "verifies ✓" : "BROKEN ✕") : "—"}</span>
          </div>
          <div style={row}>
            <span style={muted}>Events</span>
            <span>
              {status ? status.itemCount.toLocaleString() : "—"}
              {status && status.backlog > 0 ? ` · ${status.backlog} unorganized` : ""}
            </span>
          </div>
          <div style={row}>
            <span style={muted}>Organized</span>
            <span>{status ? relativeTime(status.lastOrganizedTs, now) : "—"}</span>
          </div>
          <div style={row}>
            <span style={muted}>Compaction</span>
            <span>
              {status
                ? `${status.compactedCount} · ${relativeTime(status.lastCompactionTs, now)}`
                : "—"}
            </span>
          </div>
          {heldOps && (
            <div style={row}>
              <span style={muted}>To review</span>
              <span style={{ color: "#e0913a" }}>
                {status!.pendingProposals} held proposal
                {status!.pendingProposals === 1 ? "" : "s"}
              </span>
            </div>
          )}
          {readyWork > 0 && (
            <div style={row}>
              <span style={muted}>Ready work</span>
              <span>
                {readyWork} item{readyWork === 1 ? "" : "s"} · Runs → Work
              </span>
            </div>
          )}
          <div style={{ display: "flex", gap: 6, marginTop: 2 }}>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onOpenMemory();
              }}
              style={{
                fontSize: "11px",
                padding: "3px 12px",
                borderRadius: "999px",
                cursor: "pointer",
                border:
                  "1px solid color-mix(in srgb, var(--color-info) 55%, var(--color-rule))",
                background: "color-mix(in srgb, var(--color-info) 14%, transparent)",
                color: "var(--color-ink)",
              }}
            >
              Open Memory →
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onOpenInspector();
              }}
              style={{
                fontSize: "11px",
                padding: "3px 12px",
                borderRadius: "999px",
                cursor: "pointer",
                border: "1px solid var(--color-rule)",
                background: "transparent",
                color: "var(--color-ink)",
              }}
            >
              Inspector
            </button>
          </div>
        </div>
      )}
    </>
  );
}
