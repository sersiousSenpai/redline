// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// The Localhost surface: a status list, one per dev server, answering "what
// do I have running, out of which repo?" at a glance — and letting you bring a
// dead one back without hunting for the command.
//
// Deliberately a dumb pane. Every fact arrives as a prop from useDevServers,
// every verb leaves as a callback, so the whole surface is a pure function of
// one scan. The card recipe is NudgeCard's (rule border, elevated background,
// ink / ink-muted text, no Tailwind color classes) so it inherits every theme
// including the cycling one.

import { useEffect, useMemo, useRef, useState } from "react";
import { Play, RotateCw, ShieldCheck } from "lucide-react";
import type { DevServerScan, OtherListener, RecentServer, RunningServer } from "../types";
import "./ServersPane.css";
import type { StopPlan } from "../lib/devServerTypes";
import type { ProjectOption } from "./ProjectPicker";
import { RunProjectDialog } from "./RunProjectDialog";

/** Shorten a path from the MIDDLE, keeping the leading anchor and the trailing
 *  segments. A dev server's identity lives at both ends — `~/code/…/web` says
 *  far more than `~/code/clients/acme/2026/…`. Exported for tests. */
export function middleTruncate(path: string, max = 42): string {
  if (path.length <= max) return path;
  // Keep slightly more of the tail: the repo/leaf name is the identifying part.
  const head = Math.max(4, Math.floor((max - 1) * 0.4));
  const tail = Math.max(4, max - 1 - head);
  return `${path.slice(0, head)}…${path.slice(path.length - tail)}`;
}

/** "last run 20m ago", in the coarse units a glance actually wants. Exported
 *  for tests; `now` is injected so the test isn't clock-dependent. */
export function formatLastRun(lastSeenAt: number, now = Date.now()): string {
  const secs = Math.max(0, Math.round((now - lastSeenAt) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  return months < 12 ? `${months}mo ago` : `${Math.round(months / 12)}y ago`;
}

export function splitStack(stack: string, fallbackName: string): { framework: string; name: string } {
  const separator = stack.indexOf(" — ");
  return separator < 0 ? { framework: stack, name: fallbackName }
    : { framework: stack.slice(0, separator), name: stack.slice(separator + 3) || fallbackName };
}

const btnStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "5px",
  fontSize: "11px",
  padding: "3px 8px",
  borderRadius: "4px",
  border: "1px solid var(--color-rule)",
  background: "transparent",
  color: "var(--color-ink)",
  cursor: "pointer",
};

/** The Stop button. A dev server is a reversible thing to kill — you just start
 *  it again — so a modal would be theatre. It flips to "Really stop?" in place
 *  and reverts after three seconds if you walk away. */
export function StopButton({ onStop, onArm }: {
  onStop: () => void | Promise<void>;
  onArm: () => Promise<StopPlan | null>;
}) {
  const [armed, setArmed] = useState(false);
  const [plan, setPlan] = useState<StopPlan | null>(null);
  const [stopping, setStopping] = useState(false);
  const generation = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    generation.current += 1;
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const label = plan?.collateralPorts.length
    ? `Really stop? · also ${plan.collateralPorts.map((port) => `:${port}`).join(", ")}`
    : plan && plan.pids.length > 1 ? `Really stop? · ${plan.pids.length} procs` : "Really stop?";
  return (
    <button type="button" disabled={stopping} className="rl-server-btn rl-server-btn--ghost"
      style={{
        color: armed ? "var(--color-danger, #d33)" : "var(--color-ink)",
        borderColor: armed ? "var(--color-danger, #d33)" : "var(--color-rule)",
      }}
      title={armed && plan ? `Stop ${plan.rootLabel} (pid ${plan.root}) and its server processes` : "Stop this dev server"}
      onClick={() => {
        if (!armed) {
          setArmed(true);
          setPlan(null);
          const request = ++generation.current;
          timer.current = setTimeout(() => {
            generation.current += 1;
            setArmed(false);
            setPlan(null);
          }, 3000);
          void Promise.resolve().then(onArm).then((next) => {
            if (generation.current === request) setPlan(next);
          }).catch(() => { /* A failed dry run never blocks a real stop. */ });
          return;
        }
        if (timer.current) clearTimeout(timer.current);
        const request = ++generation.current;
        setArmed(false);
        setStopping(true);
        void Promise.resolve().then(onStop).catch(() => { /* The owner surfaces stop errors. */ }).finally(() => {
          if (generation.current === request) setStopping(false);
        });
      }}>
      {stopping ? "Stopping…" : armed ? label : "Stop"}
    </button>
  );
}

function ServerRow({ live, name, framework, url, port, extra = [], portBusy = false, tooltip, action, onOpenUrl }: {
  live: boolean; name: string; framework: string; url: string; port: number; extra?: number[];
  portBusy?: boolean; tooltip: string; action: React.ReactNode; onOpenUrl: (url: string) => void;
}) {
  return <div className="rl-server-row">
    <span className="rl-server-dot" data-live={live} title={live ? "Running" : "Stopped"} />
    <span className="rl-server-name" title={tooltip}>{name}</span>
    <span className="rl-server-stack" title={framework}>{framework}</span>
    <span className="rl-server-address">
      <button type="button" className="rl-server-url" onClick={() => onOpenUrl(url)} title={`Open ${url} in the browser`}>localhost:{port}</button>
      {extra.length > 0 && <span className="rl-server-extra" title={extra.map(p => `:${p}`).join(" ")}>+{extra.length}</span>}
      {portBusy && <span className="rl-server-extra" title="Another process is listening on this port — the server will pick a different one.">port in use</span>}
    </span>
    {action}
  </div>;
}

export interface ServersPaneProps {
  scan: DevServerScan | null;
  error: string | null;
  onRefresh: () => void;
  onStop: (pid: number, port: number, projectPath: string | null) => void | Promise<void>;
  onPlanStop: (pid: number, port: number, projectPath: string | null) => Promise<StopPlan | null>;
  projectOptions: ProjectOption[];
  onRun: (projectPath: string, runCommand: string) => void;
  onOpenUrl: (url: string) => void;
}

export function ServersPane({
  scan,
  error,
  onRefresh,
  onStop,
  onPlanStop,
  projectOptions,
  onRun,
  onOpenUrl,
}: ServersPaneProps) {
  const [runDialogOpen, setRunDialogOpen] = useState(false);
  const running = useMemo(() => scan?.running ?? [], [scan]);
  const recent = useMemo(() => scan?.recent ?? [], [scan]);
  const others = scan?.others ?? [];
  const empty = running.length === 0 && recent.length === 0;

  return (
    <div
      className="rl-servers-pane"
      style={{
        height: "100%",
        overflowY: "auto",
        padding: "14px 16px 24px",
        background: "var(--color-bg)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: "12px",
        }}
      >
        <div style={{ fontSize: "13px", fontWeight: 600, color: "var(--color-ink)" }}>
          Localhost
        </div>
        <div style={{ display: "flex", gap: "6px" }}>
          <button type="button" style={btnStyle} onClick={() => setRunDialogOpen(true)}>
            <Play size={12} strokeWidth={2} />Run a project…
          </button>
          <button type="button" style={btnStyle} onClick={onRefresh} title="Re-scan now">
            <RotateCw size={12} strokeWidth={2} />Refresh
          </button>
        </div>
      </div>

      {runDialogOpen && <RunProjectDialog options={projectOptions}
        onCancel={() => setRunDialogOpen(false)}
        onRun={(path, command) => { onRun(path, command); setRunDialogOpen(false); }} />}

      {Boolean(scan?.redline?.length) && <div aria-label="Redline services" style={{
        display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px 14px",
        padding: "9px 11px", border: "1px solid var(--color-rule)", borderRadius: "6px",
        fontSize: "11px", color: "var(--color-ink-muted)",
      }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: "6px", color: "var(--color-ink)", fontWeight: 600 }}><ShieldCheck size={14} />Redline</span>
        {scan!.redline!.map((service) => <span key={service.port}>{service.role} <span style={{ fontFamily: "var(--font-mono, monospace)" }}>:{service.port}</span></span>)}
        <span style={{ marginLeft: "auto" }} title="These services keep Redline running and cannot be stopped here.">Managed by Redline</span>
      </div>}

      {error && (
        <div
          style={{
            fontSize: "11.5px",
            color: "var(--color-ink-muted)",
            border: "1px solid var(--color-rule)",
            borderRadius: "4px",
            padding: "6px 8px",
            marginBottom: "12px",
          }}
        >
          {error}
        </div>
      )}

      {(!empty || !error) && <div className="rl-servers-panel">
        {running.length > 0 && <>
          <div className="rl-servers-label">Running</div>
          {running.map((s: RunningServer) => <ServerRow key={`${s.projectPath}:${s.port}`} live
            {...splitStack(s.stack, s.projectName)} url={s.url} port={s.port} extra={s.extraPorts}
            tooltip={`${s.stack} · ${middleTruncate(s.projectPath)}`} onOpenUrl={onOpenUrl}
            action={<StopButton key={`${s.pid}:${s.port}`} onArm={() => onPlanStop(s.pid, s.port, s.projectPath)} onStop={() => onStop(s.pid, s.port, s.projectPath)} />} />)}
        </>}
        {recent.length > 0 && <>
          <div className="rl-servers-label">Recently run</div>
          {recent.map((s: RecentServer) => <ServerRow key={s.id} live={false}
            {...splitStack(s.stack, s.projectName)} url={`http://localhost:${s.port}`} port={s.port} portBusy={s.portBusy}
            tooltip={`${s.stack} · ${middleTruncate(s.projectPath)} · last run ${formatLastRun(s.lastSeenAt)}`} onOpenUrl={onOpenUrl}
            action={<button type="button" className="rl-server-btn rl-server-btn--go" disabled={!s.runCommand}
              title={s.runCommand || "Start this server"} onClick={() => onRun(s.projectPath, s.runCommand)}>Run <Play size={12} /></button>} />)}
        </>}
        {empty && <div style={{ fontSize: "12px", color: "var(--color-ink-muted)", padding: "24px 0" }}>
          {scan ? "No dev servers running, and none remembered yet. Use Run a project to start one." : "Looking for dev servers…"}
        </div>}
      </div>}

      {others.length > 0 && (
        <details className="rl-servers-others">
          <summary
            style={{
              fontSize: "11px",
              color: "var(--color-ink-muted)",
              cursor: "pointer",
            }}
          >
            Other listeners ({others.length})
          </summary>
          <div
            style={{
              marginTop: "6px",
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
              gap: "2px 14px",
            }}
          >
            {others.map((o: OtherListener) => (
              <div
                key={`${o.pid}:${o.port}`}
                style={{
                  fontSize: "11px",
                  color: "var(--color-ink-muted)",
                  fontFamily: "var(--font-mono, ui-monospace, monospace)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
                title={`pid ${o.pid}`}
              >
                {o.comm} — :{o.port}
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
