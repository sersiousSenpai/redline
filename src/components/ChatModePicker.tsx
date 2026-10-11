// SPDX-License-Identifier: Apache-2.0
import { useState } from "react";
import { backendLabel, modelsFor, effortsFor, type BackendChoice, type ModelCatalogs } from "../lib/backendChoice";
import "./ChatWorkbench.css";
export type ChatMode = "chat" | "plan" | "build";
export type BuildAssignee = "chat" | "agent";
export const nextChatMode = (mode: ChatMode): ChatMode => mode === "chat" ? "plan" : mode === "plan" ? "build" : "chat";
export function ChatModePicker({ mode, onModeChange, assignee, onAssigneeChange, harness, onHarnessChange, catalogs = {}, onOpen, warning }: {
  mode: ChatMode; onModeChange: (mode: ChatMode) => void; assignee: BuildAssignee; onAssigneeChange: (assignee: BuildAssignee) => void;
  harness: BackendChoice; onHarnessChange: (choice: BackendChoice) => void; catalogs?: ModelCatalogs; onOpen?: () => void; warning?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const delegate = mode === "plan" || (mode === "build" && assignee === "agent");
  const label = mode === "chat" ? "Chat" : mode === "plan" ? `Plan · ${backendLabel(harness.backend)}` : assignee === "chat" ? "Build · this chat" : `Build · new agent · ${backendLabel(harness.backend)}${harness.model ? ` ${harness.model}` : ""}${harness.effort ? ` ${harness.effort}` : ""}`;
  return <div className="rl-chat-mode-picker" onKeyDown={event => { if (event.key === "Escape") setOpen(false); }}>
    <button type="button" className={`rl-chat-mode-chip is-${mode}`} aria-haspopup="dialog" aria-expanded={open} onClick={() => { setOpen(value => !value); onOpen?.(); }} title="Switch mode (⇧Tab)">{label} ▾</button>
    {warning && <span className="rl-chat-build-warning" role="status">{warning}</span>}
    {/* Not modal, but it owns the pointer and Esc while it is up: the island
        dismisses it before itself (MonochatIsland's `hasChildOverlay`). */}
    {open && <div className="rl-chat-mode-menu" role="dialog" aria-label="Chat workbench mode" data-rl-island-owned>
      <fieldset><legend>Mode</legend>{(["chat", "plan", "build"] as const).map(value => <button key={value} type="button" aria-pressed={mode === value} onClick={() => onModeChange(value)}>{value === "chat" ? "Chat" : value === "plan" ? "Plan" : "Build"}</button>)}</fieldset>
      {mode === "build" && <fieldset><legend>Assignee</legend><button type="button" aria-pressed={assignee === "chat"} onClick={() => onAssigneeChange("chat")}>This chat</button><button type="button" aria-pressed={assignee === "agent"} onClick={() => onAssigneeChange("agent")}>New agent</button></fieldset>}
      {delegate && <fieldset><legend>Harness / model / effort</legend>
        <label>Harness<select value={harness.backend} onChange={event => onHarnessChange({ backend: event.target.value as BackendChoice["backend"], model: null, effort: null })}><option value="claude-code">Claude</option><option value="codex">Codex</option></select></label>
        <label>Model<select value={harness.model ?? ""} onChange={event => onHarnessChange({ ...harness, model: event.target.value || null, effort: null })}><option value="">Default</option>{modelsFor(harness.backend, catalogs).map(model => <option key={model.value} value={model.value}>{model.label}</option>)}</select></label>
        <label>Effort<select value={harness.effort ?? ""} onChange={event => onHarnessChange({ ...harness, effort: event.target.value || null })}><option value="">Default</option>{effortsFor(harness.backend, harness.model, catalogs).map(effort => <option key={effort}>{effort}</option>)}</select></label>
      </fieldset>}
      <button type="button" onClick={() => setOpen(false)}>Done</button>
    </div>}
  </div>;
}
