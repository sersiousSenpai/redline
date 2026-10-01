// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Activity } from "lucide-react";
import { formatTokens, type TurnMeter } from "../lib/turnMeter";
import { MonochatPolicyControls } from "./MonochatPolicyControls";

interface Trace {
  id: string; surface: string; intent: string; provider: string; model: string | null;
  status: string; startedAt: number; elapsedMs: number | null; meter: TurnMeter | null;
}
export function MonochatTrace({ conversationId, busy, open: controlledOpen, onOpenChange }: {
  conversationId: string; busy: boolean; open?: boolean; onOpenChange?: (open: boolean) => void;
}) {
  const [localOpen, setLocalOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  const setOpen = onOpenChange ?? setLocalOpen;
  const panelRef = useRef<HTMLElement>(null);
  const [traces, setTraces] = useState<Trace[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement, panel = panelRef.current;
    panel?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected && (document.activeElement === document.body || panel?.contains(document.activeElement))) previous.focus({ preventScroll: true });
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    void invoke<Trace[]>("monochat_traces", { companionId: conversationId }).then(rows => { if (alive) { setTraces(rows); setError(null); } }).catch(reason => { if (alive) setError(String(reason)); });
    return () => { alive = false; };
  }, [open, conversationId, busy]);
  const observed = traces.reduce((sum, trace) => sum + (trace.meter ? trace.meter.inputTokens + trace.meter.cacheReadTokens + trace.meter.cacheCreationTokens + trace.meter.outputTokens : 0), 0);
  if (controlledOpen !== undefined && !open) return null;
  return <div className="rl-monochat-observability">
    {controlledOpen === undefined && <button type="button" className="rl-monochat-trace-toggle" aria-expanded={open} onClick={() => setOpen(!open)}><Activity size={12}/> Activity & usage</button>}
    {open && <section ref={panelRef} className="rl-monochat-traces" role="dialog" aria-label="Activity and usage" onKeyDown={event => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); }
    }}>
      <button type="button" onClick={() => setOpen(false)} style={{ float: "right" }} aria-label="Close activity">Close</button>
      <div className="rl-monochat-trace-summary"><strong>Activity & usage</strong><span>{formatTokens(observed)} observed tokens</span><span>Latest {traces.length} operations in this conversation</span></div>
      <MonochatPolicyControls />
      {error && <p role="alert">Could not read activity: {error}</p>}
      {!error && traces.length === 0 && <p>Routes, timing, harnesses, and usage appear as you work.</p>}
      {traces.map(trace => <div key={trace.id} className="rl-monochat-trace-row">
        <span><strong>{trace.intent}</strong> <small>· {trace.surface} · {trace.provider}{trace.model ? ` / ${trace.model}` : ""}</small></span>
        <span>{trace.status}{trace.elapsedMs !== null ? ` · ${(trace.elapsedMs / 1000).toFixed(1)}s` : ""}</span>
        {trace.meter && <small>{formatTokens(trace.meter.inputTokens + trace.meter.cacheReadTokens + trace.meter.cacheCreationTokens)} in · {formatTokens(trace.meter.outputTokens)} out · {formatTokens(trace.meter.cacheReadTokens)} cached{trace.meter.contextWindow ? ` · ${Math.round(trace.meter.contextTokens / trace.meter.contextWindow * 100)}% context` : " · context limit not reported"}{trace.meter.costUsd != null ? ` · $${trace.meter.costUsd.toFixed(3)} reported` : " · cost not reported"}</small>}
        {trace.meter?.rateLimited && <small role="status">Rate limited{trace.meter.rateLimited.resetsAt ? ` until ${new Date(trace.meter.rateLimited.resetsAt * 1000).toLocaleTimeString()}` : " · reset not reported"}</small>}
      </div>)}
    </section>}
  </div>;
}
