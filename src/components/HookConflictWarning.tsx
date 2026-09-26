// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import type { HookConflictHealth } from "../hooks/useHookConflicts";
import { Button } from "./ui/Button";

/** Persistent, nonblocking status in the shell's content flow, below window
 * controls. Detailed actions stay in the shared modal, opened explicitly. */
export function HookConflictWarning({ health }: { health: HookConflictHealth }) {
  if (!health.hasIssue && !health.restart) return null;
  const paths = [...new Set([
    ...health.scan.conflicts.map((c) => c.identity.sourcePath),
    ...health.scan.errors.map((e) => e.sourcePath),
  ])];
  const affected = health.backend === "codex" ? "Codex" : health.backend === "claude-code" ? "Claude Code" : "Claude Code or Codex";
  return <aside role="status" aria-label="Integration hook status"
    style={{ flexShrink: 0, padding: "8px 14px", borderBottom: "1px solid var(--color-rule)", background: "var(--color-paper)", color: "var(--color-ink)", fontSize: 12, lineHeight: 1.4 }}>
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
      <div style={{ minWidth: 0 }}>
        <strong>{health.scan.conflicts.length ? "Plannotator hooks may interfere with Redline" : health.hasIssue ? "Could not inspect integration hooks" : "Hook changes saved"}</strong>
        {health.scan.conflicts.length > 0 && <div>Both integrations can intercept plan review, causing duplicate review windows or unexpected waits.</div>}
        {health.restart && <div>Restart the affected {affected} session to load the verified hook changes.</div>}
        {paths.length > 0 && <details><summary style={{ cursor: "pointer" }}>Affected configurations ({paths.length})</summary>
          {paths.map((path) => <code key={path} style={{ display: "block", overflowWrap: "anywhere" }}>{path}</code>)}
        </details>}
      </div>
      <Button size="sm" disabled={health.pending} onClick={health.openDialog} style={{ flexShrink: 0 }}>Review integration hooks</Button>
    </div>
  </aside>;
}
