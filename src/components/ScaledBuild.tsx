// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { BrowserDialog } from "./BrowserSurfaces";
import { EFFORT_OPTIONS, MODEL_OPTIONS } from "../lib/seatAssign";
import {
  estimateLabel,
  extendedLimit,
  formatMinutes,
  limitsLabel,
  pauseTitle,
  usageAgainstLimit,
  type ScaleConfig,
  type ScaledView,
} from "../lib/scaledBuild";
import { formatTokens } from "../lib/orchestration";

// SCALED BUILDS (Track O), the two moments the user decides:
//
// * Custom: the scale is set before launch (agents, models, effort, budgets).
// * The cards: the lead's workflow script is held at the Workflow hook until
//   the user presses Run, Edit or Cancel (the pre-flight), and every agent is
//   held when a limit trips until they press Extend or Stop (the pause).
//
// Both cards hold a live hook, so closing one decides nothing: it shrinks to
// a pill that reopens it. Lazy: nothing here is on the boot path.

// --- Custom ---------------------------------------------------------------------

export function ScaledBuildDialog({
  defaults,
  onLaunch,
  onClose,
}: {
  defaults: ScaleConfig;
  onLaunch: (config: ScaleConfig) => void;
  onClose: () => void;
}) {
  const [c, setC] = useState<ScaleConfig>({ ...defaults, scale: "custom" });
  const set = <K extends keyof ScaleConfig>(key: K, value: ScaleConfig[K]) => setC((prev) => ({ ...prev, [key]: value }));
  const num = (v: string, fallback: number) => (Number.isFinite(Number(v)) && v.trim() !== "" ? Number(v) : fallback);
  return (
    <BrowserDialog
      title="Build with a team"
      subtitle="A Claude dynamic workflow. Redline shows you its script before any agent starts, and pauses to ask at any limit."
      closeLabel="Cancel"
      width={520}
      onClose={onClose}
      footer={<button type="button" className="rb-button rb-button-primary" data-scaled-launch onClick={() => onLaunch(c)}>Approve &amp; build</button>}
    >
      <div className="font-sans" style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "10px 14px", alignItems: "center", fontSize: 12.5 }}>
        <label htmlFor="sb-agents">Max agents</label>
        <input id="sb-agents" className="rb-input" type="number" min={1} max={64} value={c.maxAgents}
          onChange={(e) => set("maxAgents", Math.round(num(e.target.value, c.maxAgents)))} />
        <label htmlFor="sb-lead">Lead model</label>
        <select id="sb-lead" className="rb-input" value={c.leadModel} onChange={(e) => set("leadModel", e.target.value)}>
          {MODEL_OPTIONS.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <label htmlFor="sb-worker">Builders</label>
        <select id="sb-worker" className="rb-input" value={c.workerModel ?? ""} onChange={(e) => set("workerModel", e.target.value || null)}>
          <option value="">same as the lead</option>
          {MODEL_OPTIONS.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <label htmlFor="sb-scout">Scouts (read-only)</label>
        <select id="sb-scout" className="rb-input" value={c.scoutModel ?? ""} onChange={(e) => set("scoutModel", e.target.value || null)}>
          <option value="">same as the lead</option>
          {MODEL_OPTIONS.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <label htmlFor="sb-effort">Effort</label>
        <select id="sb-effort" className="rb-input" value={c.effort ?? ""} onChange={(e) => set("effort", e.target.value || null)}>
          <option value="">model default</option>
          {EFFORT_OPTIONS.map((e) => <option key={e} value={e}>{e}</option>)}
        </select>
        <label htmlFor="sb-tokens">Token budget (millions)</label>
        <input id="sb-tokens" className="rb-input" type="number" min={0.1} step={0.5} value={c.tokenBudget / 1_000_000}
          onChange={(e) => set("tokenBudget", Math.round(num(e.target.value, c.tokenBudget / 1_000_000) * 1_000_000))} />
        <label htmlFor="sb-time">Time budget (hours)</label>
        <input id="sb-time" className="rb-input" type="number" min={0.25} step={0.5} value={c.timeBudgetMins / 60}
          onChange={(e) => set("timeBudgetMins", Math.round(num(e.target.value, c.timeBudgetMins / 60) * 60))} />
        <label htmlFor="sb-verify">Verify pass</label>
        <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input id="sb-verify" type="checkbox" checked={c.verify} onChange={(e) => set("verify", e.target.checked)} />
          end with one independent verification agent
        </label>
        <label htmlFor="sb-steer">Steer</label>
        <input id="sb-steer" className="rb-input" placeholder="One line for the lead, e.g. keep the public API stable" value={c.steer ?? ""}
          onChange={(e) => set("steer", e.target.value || null)} />
      </div>
      <p className="font-sans" style={{ margin: "12px 0 0", fontSize: 11.5, color: "var(--color-ink-muted)" }}>
        Tokens count input, output and cache writes; cache reads are not counted.
      </p>
    </BrowserDialog>
  );
}

// --- The cards --------------------------------------------------------------------------

export function ScaledBuildCards({
  nonce,
  onIdle,
  onToast,
}: {
  /** Bumped by App on every pre-flight/pause event: re-read and re-open. */
  nonce: number;
  onIdle: () => void;
  onToast: (text: string, durationMs?: number | null) => void;
}) {
  const [pending, setPending] = useState<ScaledView[] | null>(null);
  const [minimized, setMinimized] = useState(false);
  const refresh = useCallback(() => {
    void invoke<ScaledView[]>("scaled_pending")
      .then((rows) => setPending(rows ?? []))
      .catch(() => setPending([]));
  }, []);
  useEffect(() => {
    setMinimized(false);
    refresh();
  }, [nonce, refresh]);
  useEffect(() => {
    const subs = ["scaled-changed", "scaled-preflight", "scaled-paused"].map((name) => listen(name, refresh));
    return () => subs.forEach((s) => void s.then((f) => f()));
  }, [refresh]);
  useEffect(() => {
    if (pending && pending.length === 0) onIdle();
  }, [pending, onIdle]);

  const head = pending?.[0];
  if (!head) return null;
  if (minimized) {
    return (
      <button type="button" data-scaled-pill className="font-sans fixed z-50" onClick={() => setMinimized(false)}
        style={{ left: 16, bottom: 16, fontSize: 12, padding: "6px 12px", borderRadius: 999, border: "1px solid var(--color-info)", background: "var(--color-bg-elevated)", color: "var(--color-info)", cursor: "pointer", boxShadow: "0 6px 18px rgba(0,0,0,0.15)" }}>
        Team build waiting for you · Review
      </button>
    );
  }
  const done = (p: Promise<unknown>) =>
    p.catch((err) => onToast(`Couldn't send that to the team build: ${err}`, 6000)).finally(refresh);
  return head.phase.kind === "paused" ? (
    <PauseCard view={head} reason={head.phase.reason} onMinimize={() => setMinimized(true)}
      onExtend={() => done(invoke("scaled_pause_decide", { runId: head.runId, decision: "extend" }))}
      onStop={() => done(invoke("scaled_pause_decide", { runId: head.runId, decision: "stop" }))} />
  ) : (
    <PreflightCard view={head} onMinimize={() => setMinimized(true)}
      onRun={() => done(invoke("scaled_preflight_decide", { runId: head.runId, decision: "run", note: null }))}
      onEdit={(note) => done(invoke("scaled_preflight_decide", { runId: head.runId, decision: "edit", note }))}
      onCancel={() => done(invoke("scaled_preflight_decide", { runId: head.runId, decision: "cancel", note: null }))} />
  );
}

function PreflightCard({
  view,
  onRun,
  onEdit,
  onCancel,
  onMinimize,
}: {
  view: ScaledView;
  onRun: () => void;
  onEdit: (note: string) => void;
  onCancel: () => void;
  onMinimize: () => void;
}) {
  const p = view.preflight;
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState("");
  const [showScript, setShowScript] = useState(false);
  return (
    <BrowserDialog
      title="Run this team build?"
      subtitle={p?.description ?? p?.name ?? "The lead wrote a workflow for the approved plan."}
      closeLabel="Later"
      width={560}
      onClose={onMinimize}
      footer={editing ? (
        <button type="button" className="rb-button rb-button-primary" disabled={!note.trim()} onClick={() => onEdit(note.trim())}>Send changes</button>
      ) : (
        <>
          <button type="button" className="rb-button" onClick={onCancel}>Cancel build</button>
          <button type="button" className="rb-button" onClick={() => setEditing(true)}>Edit…</button>
          <button type="button" className="rb-button rb-button-primary" data-scaled-run onClick={onRun}>Run</button>
        </>
      )}
    >
      <div className="font-sans" data-scaled-preflight style={{ fontSize: 12.5, lineHeight: 1.55 }}>
        {p ? (
          <>
            <p style={{ margin: "0 0 6px", fontWeight: 600 }}>Estimate: {estimateLabel(p)}</p>
            <p style={{ margin: "0 0 10px", color: "var(--color-ink-muted)" }}>
              Limits: {limitsLabel(view.limits)}. Redline pauses every agent and asks when one is reached. The estimate is rough.
            </p>
            {p.phases.length > 0 && <p style={{ margin: "0 0 6px" }}>Phases: {p.phases.join(" → ")}</p>}
            <p style={{ margin: "0 0 6px" }}>
              Models: {p.models.map(([m, n]) => `${m} × ${n}`).join(", ") || "none named"}
              {p.dynamic && " (plus agents started per item)"}
            </p>
            {p.warnings.length > 0 && (
              <ul data-scaled-warnings style={{ margin: "8px 0", paddingLeft: 18, color: "var(--color-warning)" }}>
                {p.warnings.map((w) => <li key={w}>{w}</li>)}
              </ul>
            )}
            <button type="button" className="rb-button" style={{ marginTop: 4 }} onClick={() => setShowScript((v) => !v)}>
              {showScript ? "Hide the script" : "Read the script"}
            </button>
            {showScript && (
              <pre className="rl-thin-scroll-y" style={{ marginTop: 8, maxHeight: 260, overflow: "auto", fontSize: 11, padding: 10, borderRadius: 8, background: "var(--color-code-bg)", color: "var(--color-code-fg)" }}>
                {p.script}
              </pre>
            )}
          </>
        ) : (
          <p>The script is on its way.</p>
        )}
        {editing && (
          <textarea className="rb-input" autoFocus rows={3} style={{ width: "100%", marginTop: 10 }} value={note}
            placeholder="What should the lead change? e.g. use 3 agents, run tests in the verify step"
            onChange={(e) => setNote(e.target.value)} />
        )}
      </div>
    </BrowserDialog>
  );
}

function PauseCard({
  view,
  reason,
  onExtend,
  onStop,
  onMinimize,
}: {
  view: ScaledView;
  reason: "agents" | "tokens" | "time";
  onExtend: () => void;
  onStop: () => void;
  onMinimize: () => void;
}) {
  return (
    <BrowserDialog
      title={pauseTitle(reason)}
      subtitle="Every agent is paused until you decide."
      closeLabel="Later"
      onClose={onMinimize}
      footer={(
        <>
          <button type="button" className="rb-button" data-scaled-stop onClick={onStop}>Stop the build</button>
          <button type="button" className="rb-button rb-button-primary" data-scaled-extend onClick={onExtend}>
            Extend to {extendedLimit(view, reason)}
          </button>
        </>
      )}
    >
      <div className="font-sans" data-scaled-pause style={{ fontSize: 12.5, lineHeight: 1.55 }}>
        <p style={{ margin: "0 0 6px", fontWeight: 600 }}>{usageAgainstLimit(view, reason)}.</p>
        <p style={{ margin: 0, color: "var(--color-ink-muted)" }}>
          So far: {view.usage.agents} agents · {formatTokens(view.usage.tokens)} tokens · {formatMinutes(view.usage.minutes)}.
          Stopping ends the agents now; the lead still files its report and opens the review.
        </p>
      </div>
    </BrowserDialog>
  );
}
