// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Panel, useClickPopover } from "./popover";
import { MODEL_OPTIONS } from "../lib/seatAssign";
import { useModelCatalogs } from "../hooks/useModelCatalogs";
import { choiceLabel, effortsFor, modelsFor, normalizeChoice, type BackendChoice } from "../lib/backendChoice";

/** The harness follows the author; only this comment's model and effort vary. */
export function DiscussModelChip({ sessionId, commentId, backend, disabled = false }: { sessionId: string; commentId: string; backend?: string | null; disabled?: boolean }) {
  const harness = backend?.trim().toLowerCase() === "codex" ? "codex" : "claude-code";
  const [pick, setPick] = useState<BackendChoice>({ backend: harness, model: null, effort: null });
  const [seat, setSeat] = useState<{ model?: string; effort?: string }>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const anchor = useRef<HTMLButtonElement>(null);
  const popover = useClickPopover(anchor, "right");
  const { catalogs, errors, request } = useModelCatalogs();
  useEffect(() => {
    let current = true;
    void invoke<[string | null, string | null]>("fork_thread_model", { sessionId, commentId }).then(value => {
      if (current && Array.isArray(value)) setPick({ backend: harness, model: value[0], effort: value[1] });
    }).catch(e => { if (current) setError(String(e)); });
    void invoke<{ seats: Record<string, { model?: string; effort?: string }> }>("get_agent_seats").then(value => {
      if (current) setSeat(value?.seats?.fork_plan ?? {});
    }).catch(() => {});
    return () => { current = false; };
  }, [sessionId, commentId, harness]);
  useEffect(() => { if (popover.open) request(harness, harness); }, [popover.open, harness, request]);
  useEffect(() => { if (disabled) popover.close(); }, [disabled, popover.close]);
  const defaultLabel = harness === "codex" ? "Plan model" : [seat.model, seat.effort].filter(Boolean).join(" · ") || "CLI default";
  const label = pick.model || pick.effort ? choiceLabel(pick, catalogs).split(" · ").slice(1).join(" · ") : `Default (${defaultLabel})`;
  const save = async (next: BackendChoice) => {
    setBusy(true); setError(null);
    try { await invoke("fork_thread_set_model", { sessionId, commentId, model: next.model, effort: next.effort }); setPick(next); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };
  return <span style={{ display: "inline-flex", marginLeft: 6 }}>
    <button type="button" ref={anchor} disabled={disabled || busy} className="rl-fd-model-chip" title="Applies to the next message" aria-label="Discussion model and effort" aria-expanded={popover.open} onClick={popover.toggle}>{label} ▾</button>
    {popover.open && <Panel {...popover.panelProps} label="Discussion model and effort">
      <div className="rl-fd-menu-scroll" style={{ padding: 12 }}>
        <button type="button" className="rl-fd-menu-option" disabled={busy} onClick={() => void save({ backend: harness, model: null, effort: null })}>Default ({defaultLabel})</button>
        <label className="rl-fd-model-field">Model<select aria-label="Discussion model" disabled={busy} value={pick.model ?? ""} onChange={e => void save(normalizeChoice({ ...pick, model: e.target.value || null }, catalogs))}>
          <option value="">{defaultLabel}</option>{modelsFor(harness, catalogs).filter(model => harness === "codex" || (MODEL_OPTIONS as readonly string[]).includes(model.value)).map(model => <option key={model.value} value={model.value}>{model.label}</option>)}
        </select></label>
        <label className="rl-fd-model-field">Effort<select aria-label="Discussion effort" disabled={busy} value={pick.effort ?? ""} onChange={e => void save({ ...pick, effort: e.target.value || null })}>
          <option value="">Default</option>{effortsFor(harness, pick.model, catalogs).map(effort => <option key={effort} value={effort}>{effort}</option>)}
        </select></label>
        {(error || errors[harness]) && <p role="alert">{error || errors[harness]}</p>}
      </div>
    </Panel>}
  </span>;
}
