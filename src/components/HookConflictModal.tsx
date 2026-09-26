// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import type { HookConflictHealth } from "../hooks/useHookConflicts";
import { useMenuOverlay } from "./menuOverlay";
import { Button } from "./ui/Button";

/** Explicitly opened details and removal actions. A body portal keeps the
 * modal out of the header's flow and animated chrome transforms. */
export function HookConflictModal({ health }: { health: HookConflictHealth }) {
  const [viewError, setViewError] = useState<string | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const { scan, pending, error, restart, hasIssue, closeDialog } = health;
  const affected = health.backend === "codex" ? "Codex" : health.backend === "claude-code" ? "Claude Code" : "Claude Code or Codex";
  useMenuOverlay(true);

  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    card.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  useLayoutEffect(() => {
    // Removing a conflict also removes its focused action. Keep keyboard
    // focus inside the result instead of returning it to the underlying app.
    if (card.current && !card.current.contains(document.activeElement)) card.current.focus();
  }, [scan, pending, restart]);

  const groups = Array.from(new Set(scan.conflicts.map((c) => `${c.identity.sourcePath}\n${c.action}`))).map((key) =>
    scan.conflicts.filter((c) => `${c.identity.sourcePath}\n${c.action}` === key));
  const view = async (path: string) => {
    setViewError(null);
    try { await revealItemInDir(path); } catch (err) { setViewError(String(err)); }
  };

  return createPortal(
    <div
      className="fixed inset-0 flex items-center justify-center z-50"
      style={{ background: "var(--color-overlay)", padding: "48px 24px" }}
      onClick={(e) => { if (e.target === e.currentTarget) closeDialog(); }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") { e.preventDefault(); closeDialog(); }
        if (e.key === "Tab" && card.current) {
          const controls = [...card.current.querySelectorAll<HTMLElement>("button:not(:disabled), summary")];
          const first = controls[0]; const last = controls[controls.length - 1];
          if (!first) { e.preventDefault(); card.current.focus(); }
          else if (e.shiftKey && (document.activeElement === first || document.activeElement === card.current)) { e.preventDefault(); last.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
      }}
    >
      <div ref={card} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-busy={pending} tabIndex={-1}
        className="rounded-md shadow-xl border flex flex-col"
        style={{ width: "min(620px, 100%)", maxHeight: "calc(100dvh - 96px)", overflow: "hidden", borderColor: "var(--color-rule)", background: "var(--color-bg-elevated)", color: "var(--color-ink)", outline: "none" }}>
        <div className="flex items-start justify-between gap-4 px-6 pt-6 pb-3">
          <h2 id={titleId} className="font-serif font-semibold" style={{ fontSize: 20 }}>
            {restart && !hasIssue ? "Hook changes saved" : scan.conflicts.length ? "Plannotator hook conflict" : "Integration hooks"}
          </h2>
          <Button variant="ghost" ariaLabel="Close integration hooks" disabled={pending} onClick={closeDialog} style={{ color: "var(--color-ink-muted)", padding: 4 }}>✕</Button>
        </div>
        <div className="px-6 pb-4" style={{ overflowY: "auto", minHeight: 0, fontSize: 13, lineHeight: 1.55 }}>
          {scan.conflicts.length > 0 && <p style={{ margin: "0 0 16px" }}>Plannotator hooks may interfere with Redline. Both integrations can intercept plan review, causing duplicate review windows or unexpected waits.</p>}
          {groups.map((conflicts) => {
            const first = conflicts[0]; const path = first.identity.sourcePath;
            return <details key={`${path}-${first.action}`} open className="rounded-md border p-3" style={{ marginTop: 10, borderColor: "var(--color-rule)", background: "var(--color-paper)" }}>
              <summary style={{ cursor: "pointer", overflowWrap: "anywhere", fontSize: 12 }}><code>{path}</code> · {Array.from(new Set(conflicts.map((c) => c.event))).join(", ")}</summary>
              <p style={{ margin: "8px 0" }}>{first.detail}</p>
              {first.command && <code style={{ display: "block", whiteSpace: "pre-wrap", overflowWrap: "anywhere", color: "var(--color-ink-muted)", fontSize: 12, marginBottom: 12 }}>{Array.from(new Set(conflicts.map((c) => c.command))).join("\n")}</code>}
              <div className="flex gap-2 flex-wrap">
                {first.action !== "view" && <Button size="sm" disabled={pending} onClick={() => void health.remove(conflicts.map((c) => c.identity))}>
                  {pending ? "Updating hooks…" : first.action === "disablePlugin" ? "Disable Plannotator plugin" : "Uninstall Plannotator hooks"}
                </Button>}
                <Button size="sm" disabled={pending} onClick={() => void view(path)}>View configuration</Button>
              </div>
            </details>;
          })}
          {scan.errors.map((inspection) => <div key={inspection.sourcePath} role="alert" style={{ marginTop: 12 }}>
            <strong>Could not inspect hook configuration</strong><br /><code style={{ overflowWrap: "anywhere" }}>{inspection.sourcePath}</code>: {inspection.message}
            <Button size="sm" disabled={pending} onClick={() => void view(inspection.sourcePath)} style={{ marginTop: 8 }}>View configuration</Button>
          </div>)}
          {(error || viewError) && <p role="alert" style={{ color: "var(--color-warning)", whiteSpace: "pre-wrap", overflowWrap: "anywhere", marginTop: 12 }}>{error || viewError}</p>}
          {restart && <p role="status" style={{ margin: hasIssue ? "16px 0 0" : 0 }}>Hook changes saved and checked. Restart the affected {affected} session to load them.</p>}
          {!health.checked && <p role="status">Checking integration hooks…</p>}
          {health.checked && !hasIssue && !restart && <p style={{ margin: 0 }}>No configured Plannotator plan hooks detected for this backend and project.</p>}
          {health.watchError && <p style={{ color: "var(--color-ink-muted)" }}>Live configuration watching is unavailable. Redline checks again when the window regains focus.</p>}
        </div>
        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t" style={{ borderColor: "var(--color-rule)" }}>
          <Button size="sm" disabled={pending} onClick={() => void health.refresh()}>Check again</Button>
          <Button size="sm" variant="accent" disabled={pending} onClick={closeDialog}>{pending ? "Updating hooks…" : hasIssue ? "Not now" : "Done"}</Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
