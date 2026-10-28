// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { usePoll } from "../hooks/usePoll";

import { useMenuOverlay } from "./menuOverlay";

// Memory's quiet chip on the status bar's left (D26: it left the top bar,
// where it was a pill): a dot and the word "Memory", with the line the pill
// used to wear — "organized 8m ago · 1236 ready" — in its tooltip. A click
// opens the same small status popover, now rising from the bar — chain
// state, last organize, compaction — with "Open Memory →" into the full
// surface and a quick-inspector escape hatch. It listens for
// `memory-changed` (emitted by the background keeper and the manual
// commands) and re-reads.

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
  /** Structural proposals in the gardener's work queue, waiting for a run
   *  (B3). A fact about the gardener, never a count to review. */
  queuedProposals: number;
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

/** How often the chip's relative time may move on its own while idle. */
export const LABEL_TICK_MS = 5 * 60_000;

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
    if (status.lastOrganizedTs) return `Memory · organized ${relativeTime(status.lastOrganizedTs, now)}`;
    if (status.itemCount > 0) return `Memory · ${status.itemCount} captured`;
    return "Memory";
  })();
  return readyWork > 0 ? `${base} · ${readyWork} ready` : base;
}

/** The chip's tooltip: the line the pill wore ("Memory · organized 8m ago ·
 *  1236 ready"), then the counts behind it. Pure. */
export function chipTitle(status: MemoryStatus | null, now: number, readyWork = 0): string {
  const line = pillLabel(status, now, readyWork);
  if (!status) return line === "Memory" ? "Open memory" : line;
  return `${line}\n${status.itemCount} events · ${status.backlog} awaiting organize · ${status.compactedCount} compacted · chain ${status.chainOk ? "OK" : "BROKEN"}`;
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
  const [pos, setPos] = useState({ bottom: 0, left: 0 });
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  // Hide the native browser webview while this menu is up (see useMenuOverlay).
  useMenuOverlay(open);

  // The clock the relative times read. Idle, the bar must not repaint on a
  // tick: it moves when the status does, when the pointer comes to the chip
  // or its popover opens, and otherwise at most every five minutes (a 60 s
  // poll used to hand over a fresh object every minute, and with it "30m
  // ago" → "31m ago" re-rendering and repainting the header it lived in).
  const [now, setNow] = useState(() => Date.now());
  const statusKeyRef = useRef("");
  usePoll(() => setNow(Date.now()), LABEL_TICK_MS, { pauseWhenHidden: true, leading: false });
  const load = useCallback(async () => {
    try {
      const next = await invoke<MemoryStatus>("memory_status");
      const key = JSON.stringify(next);
      if (key !== statusKeyRef.current) {
        statusKeyRef.current = key;
        setStatus(next);
        setNow(Date.now());
      }
    } catch {
      /* best-effort: the pill is ambient, never an error surface */
    }
    try {
      // One COUNT(*), not the whole work graph — this runs every 60s and on
      // every memory event.
      setReadyWork(await invoke<number>("work_ready_count"));
    } catch {
      /* same best-effort rule: no ready count is a hidden segment, not an error */
    }
  }, []);

  // A slow poll keeps the relative time honest even between keeper runs, and
  // rests while the window is hidden. Every read goes through it.
  const loadNow = usePoll(load, 60_000, { pauseWhenHidden: true });
  useEffect(() => {
    // Coalesce the change bursts. A browse capture emits `memory-changed` per
    // captured page, so a few seconds of browsing used to fire a status read
    // per page; the pill is ambient, and one read a second is plenty.
    let coalesce: number | undefined;
    const reload = () => {
      window.clearTimeout(coalesce);
      coalesce = window.setTimeout(loadNow, 1_000);
    };
    const un = listen("memory-changed", reload);
    // Accepting/rejecting a held proposal emits only classmem-changed — the
    // pill's review count must follow it, not just the keeper's heartbeat.
    const unClass = listen("classmem-changed", reload);
    return () => {
      window.clearTimeout(coalesce);
      void un.then((f) => f());
      void unClass.then((f) => f());
    };
  }, [loadNow]);

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
    setNow(Date.now());
    const r = btnRef.current?.getBoundingClientRect();
    // Fixed positioning so the popover escapes the bar's clipping half (each
    // side of the status bar scrolls on its own); the chip sits on the
    // window's bottom row, so it always rises.
    if (r) setPos({ bottom: window.innerHeight - r.top + 6, left: Math.max(8, r.left - 6) });
    setOpen((v) => !v);
  };

  const chainBad = status != null && !status.chainOk;
  const queued = status != null && status.queuedProposals > 0;

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
        className="rl-statusbar-quiet rl-mem-chip"
        title={chipTitle(status, now, readyWork)}
        aria-label="Memory status"
        aria-expanded={open}
        onPointerEnter={() => setNow(Date.now())}
      >
        {/* A broken chain outranks the quiet green, in amber: nothing on the
            frame is red. The gardener's queue never colours it (B3): a
            queued proposal is a fact about the next run, not an op waiting
            on a person. */}
        <span aria-hidden className="rl-statusbar-dot" style={{ background: chainBad ? "var(--color-warning)" : "var(--color-success)" }} />
        <span>Memory</span>
      </button>
      {open && (
        <div
          ref={popRef}
          className="font-sans"
          style={{
            position: "fixed",
            bottom: pos.bottom,
            left: pos.left,
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
          {queued && (
            <div style={row}>
              <span style={muted}>Queued</span>
              <span>
                {status!.queuedProposals} waiting for a run
              </span>
            </div>
          )}
          {readyWork > 0 && (
            <div style={row}>
              <span style={muted}>Ready work</span>
              <span>
                {readyWork} item{readyWork === 1 ? "" : "s"}
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
