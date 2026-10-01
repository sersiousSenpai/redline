// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface Policy {
  conversationTokenBudget: number | null;
  runTokenBudget: number | null;
  codexParallelism: number;
  claudeParallelism: number;
}

/** Dispatch thresholds use measured tokens; they never imply a billing cap. */
export function MonochatPolicyControls() {
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<"idle" | "saving" | "saved">("idle");
  useEffect(() => {
    let alive = true;
    void invoke<Policy>("monochat_policy_get").then(value => { if (alive) setPolicy(value); }).catch(reason => { if (alive) setError(String(reason)); });
    return () => { alive = false; };
  }, []);
  const save = async () => {
    if (!policy) return;
    setState("saving"); setError(null);
    try { await invoke("monochat_policy_set", { policy }); setState("saved"); }
    catch (reason) { setError(String(reason)); setState("idle"); }
  };
  return <details className="rl-monochat-policy">
    <summary>Usage & concurrency preferences</summary>
    <p>Pause new dispatch after an observed token threshold. Active turns finish and may exceed it. Blank means no threshold.</p>
    {policy && <fieldset disabled={state === "saving"}>
      {([ ["conversationTokenBudget", "Conversation tokens"], ["runTokenBudget", "Run tokens"], ["codexParallelism", "Codex tasks per run"], ["claudeParallelism", "Claude tasks per run"] ] as const).map(([key, label]) => {
        const concurrency = key.endsWith("Parallelism");
        return <label key={key}>{label}<input aria-label={label} type="number" min={concurrency ? 1 : 1000} max={concurrency ? 16 : 1000000000} step={concurrency ? 1 : 1000} value={policy[key] ?? ""} placeholder={concurrency ? undefined : "No threshold"} onChange={event => { const value = event.currentTarget.value; setPolicy({ ...policy, [key]: value === "" ? (concurrency ? 1 : null) : Number(value) }); setState("idle"); }}/></label>;
      })}
      <button type="button" onClick={() => void save()}>{state === "saving" ? "Saving…" : state === "saved" ? "Saved" : "Save preferences"}</button>
    </fieldset>}
    {error && <p role="alert">{error}</p>}
  </details>;
}
