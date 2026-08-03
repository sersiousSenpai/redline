// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// The one quiet ambient surface for "memory is plumbing". A single rounded pill
// that shows memory is alive and last did something — no configs, no console.
// Click opens the slim read-mostly inspector. It listens for `memory-changed`
// (emitted by the background keeper and the manual commands) and re-reads.

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

/** The pill's one-line label. Pure. */
export function pillLabel(status: MemoryStatus | null, now: number): string {
  if (!status) return "Memory";
  if (status.lastOrganizedTs) return `Memory · organized ${relativeTime(status.lastOrganizedTs, now)}`;
  if (status.itemCount > 0) return `Memory · ${status.itemCount} captured`;
  return "Memory";
}

export function MemoryStatusPill({ onOpen }: { onOpen: () => void }) {
  const [status, setStatus] = useState<MemoryStatus | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await invoke<MemoryStatus>("memory_status"));
    } catch {
      /* best-effort: the pill is ambient, never an error surface */
    }
  }, []);

  useEffect(() => {
    void load();
    const un = listen("memory-changed", () => void load());
    // A slow poll keeps the relative time honest even between keeper runs.
    const t = window.setInterval(() => void load(), 60_000);
    return () => {
      window.clearInterval(t);
      void un.then((f) => f());
    };
  }, [load]);

  const now = Date.now();
  const chainBad = status != null && !status.chainOk;

  return (
    <button
      type="button"
      onClick={onOpen}
      title={
        status
          ? `${status.itemCount} events · ${status.backlog} awaiting organize · ${
              status.compactedCount
            } compacted · chain ${status.chainOk ? "OK" : "BROKEN"}`
          : "Open memory"
      }
      aria-label="Open memory"
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
          background: chainBad ? "#d64545" : "#2fae66",
          boxShadow: chainBad ? "none" : "0 0 4px rgba(47,174,102,0.8)",
        }}
      />
      <span style={{ whiteSpace: "nowrap" }}>{pillLabel(status, now)}</span>
    </button>
  );
}
