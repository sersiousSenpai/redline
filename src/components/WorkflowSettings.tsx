// SPDX-License-Identifier: Apache-2.0
// Feature preferences load only when Settings is opened.
import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useReviewPose } from "../hooks/useReviewPose";
export default function WorkflowSettings({ Row }: { Row: ComponentType<{label:string;children:ReactNode}> }) {
  const [reviewPose, setReviewPose] = useReviewPose();
  return <>
    <Row label="Show Git in plain language"><input type="checkbox" aria-label="Show Git in plain language" checked={reviewPose === "guided"} onChange={event => setReviewPose(event.target.checked ? "guided" : "expert")}/></Row>
    <Row label="New terminal tabs"><TerminalDefaultSetting/></Row>
    <Row label="Group shell commands"><ShellIntegrationSetting/></Row>
  </>;
}

function TerminalDefaultSetting() {
  const [view, setView] = useState<"shell" | "raw">("shell");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(true);
  useEffect(() => {
    let live = true;
    void invoke<string>("terminal_default_view_get").then(value => { if (live) setView(value === "raw" ? "raw" : "shell"); }).catch(error => { if (live) setError(String(error)); }).finally(() => { if (live) setPending(false); });
    return () => { live = false; };
  }, []);
  return <span className="flex flex-col gap-1">
    <select aria-label="Default terminal view" value={view} disabled={pending} onChange={event => {
      const next = event.target.value === "raw" ? "raw" : "shell";
      setPending(true); setError(null);
      void invoke("terminal_default_view_set", { view: next }).then(() => setView(next)).catch(error => setError(String(error))).finally(() => setPending(false));
    }} style={{ background: "var(--color-paper)", color: "var(--color-ink)", fontSize: 11 }}>
      <option value="shell">Structured shell</option><option value="raw">Raw terminal</option>
    </select>
    {error && <span role="alert" className="text-xs" style={{ color: "var(--color-warning)" }}>{error}</span>}
  </span>;
}

function ShellIntegrationSetting() {
  const [enabled, setEnabled] = useState(true);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { let live = true; void invoke<boolean>("shell_integration_get").then(value => { if (live) setEnabled(value); }).catch(error => { if (live) setError(String(error)); }).finally(() => { if (live) setPending(false); }); return () => { live = false; }; }, []);
  return <span><input type="checkbox" aria-label="Group shell commands" title="Use command blocks in new shell tabs" checked={enabled} disabled={pending} onChange={event => {
    const next = event.target.checked; setPending(true); setError(null);
    void invoke("shell_integration_set", { enabled: next }).then(() => setEnabled(next)).catch(error => setError(String(error))).finally(() => setPending(false));
  }}/>{error && <span role="alert" className="text-xs">{error}</span>}</span>;
}
