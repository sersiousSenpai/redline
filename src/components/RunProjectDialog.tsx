// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ProjectPicker, type ProjectOption } from "./ProjectPicker";
import { scriptCommand, type ProbeView } from "../lib/devServerTypes";

interface RunProjectDialogProps {
  options: ProjectOption[];
  onRun: (projectPath: string, command: string) => void;
  onCancel: () => void;
}

/** Start in any known or browsed directory through the existing terminal path. */
export function RunProjectDialog({ options, onRun, onCancel }: RunProjectDialogProps) {
  const [project, setProject] = useState<string | null>(null);
  const [command, setCommand] = useState("");
  const [probe, setProbe] = useState<ProbeView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const edited = useRef(false);
  const card = useRef<HTMLFormElement>(null);
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    card.current?.querySelector<HTMLElement>("button")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector('[role="menu"]')) {
        e.preventDefault();
        cancelRef.current();
      }
      if (e.key === "Tab" && card.current && !document.querySelector('[role="menu"]')) {
        const controls = [...card.current.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)")];
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault(); last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault(); first?.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); previous?.focus(); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    edited.current = false;
    setCommand("");
    setProbe(null);
    setError(null);
    setLoading(project !== null);
    if (project) {
      void invoke<ProbeView>("dev_server_probe", { projectPath: project }).then((next) => {
        if (cancelled) return;
        setProbe(next);
        if (!edited.current) setCommand(next.runCommand);
      }).catch((e: unknown) => {
        if (!cancelled) setError(`Couldn't suggest a command: ${String(e)}`);
      }).finally(() => { if (!cancelled) setLoading(false); });
    }
    return () => { cancelled = true; };
  }, [project]);

  const canRun = Boolean(project && command.trim() && !loading && probe?.exists !== false);
  const buttonStyle: React.CSSProperties = {
    fontSize: "12px", padding: "6px 12px", borderRadius: "4px",
    border: "1px solid var(--color-rule)", color: "var(--color-ink)",
    background: "var(--color-bg-elevated)", cursor: "pointer",
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.4)" }}
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <form ref={card} role="dialog" aria-modal="true" aria-labelledby="run-project-title"
        className="rounded-lg flex flex-col gap-3 p-5"
        style={{ width: "min(30rem, 92vw)", maxHeight: "90vh", overflowY: "auto",
          background: "var(--color-paper)", border: "1px solid var(--color-rule)",
          boxShadow: "0 12px 40px rgba(0,0,0,0.3)" }}
        onSubmit={(e) => { e.preventDefault(); if (canRun && project) onRun(project, command.trim()); }}>
        <h2 id="run-project-title" style={{ fontSize: "14px", fontWeight: 600, color: "var(--color-ink)" }}>Run a project</h2>
        <div style={{ fontSize: "12px", color: "var(--color-ink-muted)" }}>Choose a project or browse to its folder.</div>
        <ProjectPicker options={options} value={project} onChange={setProject} />
        {project && <div title={project} style={{ fontSize: "11px", color: "var(--color-ink-muted)", overflowWrap: "anywhere" }}>{project}</div>}
        {loading && <div role="status" style={{ fontSize: "12px" }}>Looking for a run command…</div>}
        {probe?.stack && <div style={{ fontSize: "12px", color: "var(--color-ink-muted)" }}>{probe.stack}</div>}
        {probe?.exists === false && <div role="alert" style={{ fontSize: "12px", color: "var(--color-danger)" }}>This folder no longer exists. Choose another project.</div>}
        {error && <div role="status" style={{ fontSize: "12px", color: "var(--color-ink-muted)" }}>{error} You can enter one below.</div>}
        <label htmlFor="run-project-command" style={{ fontSize: "12px", fontWeight: 600, color: "var(--color-ink)" }}>Command</label>
        <input id="run-project-command" value={command} autoComplete="off" spellCheck={false}
          placeholder="npm run dev" disabled={!project}
          onChange={(e) => { edited.current = true; setCommand(e.target.value); }}
          style={{ padding: "8px", borderRadius: "4px", border: "1px solid var(--color-rule)",
            background: "var(--color-bg-elevated)", color: "var(--color-ink)", fontFamily: "var(--font-mono, monospace)", fontSize: "12px" }} />
        {Boolean(probe?.scripts.length) && <div className="flex flex-wrap gap-1" aria-label="Project scripts">
          {probe!.scripts.map((script) => <button key={script} type="button" style={buttonStyle}
            onClick={() => { edited.current = true; setCommand(scriptCommand(probe!.packageManager, script)); }}>{script}</button>)}
        </div>}
        <div className="flex items-center justify-end gap-2 mt-1">
          <button type="button" style={buttonStyle} onClick={onCancel}>Cancel</button>
          <button type="submit" disabled={!canRun} style={{ ...buttonStyle,
            background: "var(--color-info)", color: "var(--color-on-accent)", opacity: canRun ? 1 : 0.5 }}>Run ▶</button>
        </div>
      </form>
    </div>
  );
}
