// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef } from "react";
import { backendLabel, type Backend } from "../lib/backendChoice";
import type { PreflightStatus } from "../lib/readiness";
import { CopyChip } from "./CopyChip";

export function IntegrationSetupDialog({ backend, health, busy, progress, error, done, pending, onInstall, onDismiss, onReviewHooks, onLocate }: {
  backend: Backend; health: PreflightStatus | null; busy: boolean;
  progress: string | null; error: string | null; done: boolean; pending: boolean;
  onInstall: () => void; onDismiss: () => void;
  onReviewHooks?: () => void; onLocate?: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog?.showModal();
    return () => { dialog?.close(); previous?.focus({ preventScroll: true }); };
  }, []);
  const label = backendLabel(backend);
  const codex = backend === "codex";
  const provider = health?.providers?.[backend];
  const hook = codex ? health?.codexHook?.installed : backend === "claude-code" ? health?.hook.installed : provider?.hook.installed;
  const skill = codex ? health?.codexSkill : backend === "claude-code" ? health?.skill : provider?.skill;
  const profile = health?.codex?.profile;
  return <dialog ref={ref} className="rl-integration-dialog" aria-labelledby="integration-title"
    onCancel={event => { event.preventDefault(); if (!busy) onDismiss(); }}>
    <div className="rl-integration-eyebrow">{label} integration</div>
    <h2 id="integration-title">{done ? "Integration files verified" : `Connect ${label} to Redline`}</h2>
    <p>{done
      ? "Your review hooks and instructions are up to date."
      : "Set up the components that bring plans, revisions, and captured prompts into Redline. Your message and project stay here."}</p>
    <div className="rl-integration-pieces">
      {codex && <div><span aria-hidden>{health?.codex?.usable ? "✓" : "○"}</span> Codex CLI <small>{health?.codex?.usable ? `Version ${health.codex.version ?? "detected"}` : health?.codex?.found ? "Update required" : "Not installed"}</small></div>}
      {codex && health?.codex?.usable && <div><span aria-hidden>{health.codex.signedIn ? "✓" : "○"}</span> Codex account <small>{health.codex.authState === "signed-out" ? "Sign in required" : health.codex.signedIn ? "Connected" : "Not verified"}</small></div>}
      <div><span aria-hidden>{hook ? "✓" : "○"}</span> Plan and prompt hooks <small>{hook ? "Installed" : "Needs setup"}</small></div>
      {codex && <div><span aria-hidden>{profile?.installed && !profile.outdated ? "✓" : "○"}</span> Planning instructions and launcher <small>{profile?.outdated ? "Update needed" : profile?.installed ? "Current" : "Needs setup"}</small></div>}
      <div><span aria-hidden>{skill?.installed && !skill.outdated ? "✓" : "○"}</span> Review and collaboration skills <small>{skill?.outdated ? "Update needed" : skill?.installed ? "Current" : "Needs setup"}</small></div>
      {codex && hook && <div><span aria-hidden>{health?.codexHook?.trust === "trusted" ? "✓" : "○"}</span> Hook trust <small>{health?.codexHook?.trust === "trusted" ? "Verified by Codex" : "Needs review"}</small></div>}
    </div>
    {codex && !health?.codex?.usable && <p>Installs the official @openai/codex package in Redline’s private runtime folder using npm. Your existing Codex installation stays available.</p>}
    {codex && health?.codex?.path && <details><summary>Detected installation</summary><p><code>{health.codex.path}</code><br/>Version {health.codex.version ?? "not reported"}</p></details>}
    {(codex || backend === "claude-code") && <p className="rl-integration-trust">{codex ? "Codex requires trust for new or modified hooks. " : "Your harness may ask you to approve new hooks. "}Open <CopyChip text="/hooks" title="Copy /hooks"/> in {label} to review them. Installing files does not grant trust.</p>}
    {error && <p className="rl-integration-error" role="alert">{error}</p>}
    {busy && <p role="status" aria-live="polite">{progress ?? "Checking integration…"}</p>}
    <div className="rl-integration-actions">
      <button type="button" disabled={busy} onClick={onDismiss}>{done ? "Done" : "Later"}</button>
      {codex && onLocate && <button type="button" disabled={busy} onClick={onLocate}>Locate CLI…</button>}
      {codex && health?.codex?.usable && (health.codex.authState === "signed-out" || hook && health?.codexHook?.trust !== "trusted") && onReviewHooks && <button type="button" disabled={busy} onClick={onReviewHooks}>{health.codex.authState === "signed-out" ? "Sign in to Codex" : "Review hooks in Codex"}</button>}
      {!done && <button type="button" className="primary" disabled={busy} onClick={onInstall}>{busy ? "Working…" : codex && hook && health?.codex?.usable ? "Verify and continue" : pending ? "Install and continue" : error ? "Retry setup" : "Install integration"}</button>}
    </div>
  </dialog>;
}
