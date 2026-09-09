// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useRunGraph } from "../../hooks/useRunGraph";
import { editableGraph, isLiveNode, newNode, type NodeKind, type RunGraph, type RunNode } from "../../lib/runner/schema";
import { measuredSummary, mergeNodeOps, splitNodeOps } from "../../lib/runner/view";
import type { Applied, NodePatch, RunOp } from "../../lib/runner/ops";
import type { NodeStream } from "../../lib/runner/stream";
import { RunCanvas } from "./RunCanvas";
import type { DiffFile } from "../../types";

export interface RunGraphPaneProps {
  runId: string; active: boolean;
  onOpenPlanBlock?: (sessionId: string, blockId: string) => void;
  onReviewSession?: (reviewId: string) => void;
}
const freshId = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;
const ignoreHandledError = () => {};

export function RunGraphPane({ runId, active, onOpenPlanBlock, onReviewSession }: RunGraphPaneProps) {
  const run = useRunGraph(runId, active);
  const { graph, streams, nextIds, error, busy } = run;
  const [selected, setSelected] = useState<string | null>(null);
  const [undo, setUndo] = useState<RunOp[]>([]);
  const [localError, setLocalError] = useState<string | null>(null);
  const [report, setReport] = useState<MeasuredReport | null>(null);
  useEffect(() => { setSelected(null); setUndo([]); setReport(null); }, [runId]);
  const apply = async (ops: RunOp[]): Promise<Applied | undefined> => {
    setLocalError(null);
    const result = await run.apply(ops);
    if (result) setUndo(result.inverses);
    return result;
  };
  const doApply = (ops: RunOp[]) => { void apply(ops).catch(ignoreHandledError); };
  const node = graph?.nodes.find((n) => n.id === selected) ?? null;
  const openBlock = useCallback((blockId: string) => {
    if (graph?.planSessionId) onOpenPlanBlock?.(graph.planSessionId, blockId);
  }, [graph?.planSessionId, onOpenPlanBlock]);
  const readReport = async () => {
    try { setReport(await invoke<MeasuredReport>("runner_report", { runId })); }
    catch (e) { setLocalError(String(e)); }
  };
  const review = async () => {
    try { const result = await invoke<{ reviewId: string }>("runner_review", { runId }); onReviewSession?.(result.reviewId); }
    catch (e) { setLocalError(String(e)); }
  };
  if (!graph) return <div className="rl-run-pane"><p>{error ?? "Reading the run graph…"}</p></div>;
  const editable = editableGraph(graph);
  const summary = measuredSummary(graph, Object.fromEntries(Object.entries(streams).map(([id, stream]) => [id, stream.meter])));
  return <section className="rl-run-pane" aria-label="Run graph">
    <div className="rl-run-toolbar">
      <strong>{graph.status === "draft" ? "Review the run plan" : graph.status === "ready" ? "Approved for queue" : `Run · ${graph.status}`}</strong>
      <span className="rl-run-hint">Revision {graph.rev}</span>
      {graph.status === "draft" && <button disabled={busy} onClick={() => void run.intervene("ready").catch(ignoreHandledError)}>Approve for queue</button>}
      {["draft", "ready", "paused"].includes(graph.status) && <button className="rl-run-primary" disabled={busy || graph.nodes.some((n) => isLiveNode(n.status))} onClick={() => void run.start().catch(ignoreHandledError)}>{graph.status === "paused" ? "Resume run" : "Run"}</button>}
      {graph.status === "running" && <button disabled={busy} title="Let active nodes finish; hold the next nodes" onClick={() => void run.intervene("pause").catch(ignoreHandledError)}>Pause scheduling</button>}
      {graph.nodes.some((n) => isLiveNode(n.status)) && <button className="rl-run-danger" disabled={busy} onClick={() => void run.intervene("stop").catch(ignoreHandledError)}>Stop run</button>}
      <button onClick={() => void readReport()}>Measured report</button>
      {onReviewSession && <button disabled={graph.nodes.some((n) => isLiveNode(n.status))} onClick={() => void review()}>Review changes</button>}
    </div>
    <p className="rl-run-subtitle">{graph.status === "draft" ? "Edit the tasks, dependencies and checks before starting. Scope hints guide scheduling; claimed files determine ownership." : graph.projectPath}</p>
    {(error || localError) && <div className="rl-run-error" role="alert">{error ?? localError}</div>}
    <div className="rl-run-toolbar">
      {(["task", "check", "review", "gate"] as NodeKind[]).map((kind) => <button key={kind} disabled={!editable || busy} onClick={() => {
        const added = newNode(freshId("n"), kind);
        void apply([{ op: "add_node", node: added }]).then((result) => { if (result) setSelected(added.id); }).catch(ignoreHandledError);
      }}>+ {kind}</button>)}
      <button disabled={!editable || !undo.length || busy} onClick={() => doApply(undo)}>Undo edit</button>
      <label className="rl-run-hint" style={{ marginLeft: "auto" }}>Parallel tasks <select aria-label="Maximum concurrent write tasks" value={graph.maxWriteParallel} disabled={!editable || busy} onChange={(e) => doApply([{ op: "set_parallelism", value: Number(e.target.value) }])}>{Array.from({ length: 16 }, (_, i) => <option key={i + 1}>{i + 1}</option>)}</select></label>
    </div>
    <div className="rl-run-body">
      <div className="rl-run-canvas"><RunCanvas graph={graph} streams={streams} nextIds={nextIds} selectedId={selected} onSelect={setSelected}
        onMove={(id, position) => doApply([{ op: "update_node", id, set: { position } }])}
        onConnect={(from, to) => doApply([{ op: "add_edge", edge: { id: freshId("e"), from, to, type: "blocks" } }])}
        onOpenPlanBlock={onOpenPlanBlock ? openBlock : undefined} /></div>
      <aside className="rl-run-inspector">
        {node ? <NodeInspector key={node.id} graph={graph} node={node} stream={streams[node.id]} busy={busy} apply={apply}
          intervene={run.intervene} onError={setLocalError} /> : <>
          <h3>{editable ? "Shape the work" : "Inspect a node"}</h3>
          <p className="rl-run-hint">Select a node to {editable ? "rewrite its brief, assign a model, scope a check or add a dependency" : "read its output, inspect its measured result or send a follow-up"}.</p>
          <p className="rl-run-hint">{editable ? "Drag nodes to arrange them. Connect the right handle to another node’s left handle to add a blocking dependency." : "Pause scheduling to edit nodes after active turns finish. Stop ends a running turn."}</p>
          <h3>Scheduling order</h3>
          <ol style={{ paddingLeft: 20 }}>{graph.nodes.map((n) => <li key={n.id}><button onClick={() => setSelected(n.id)} style={{ border: 0, textAlign: "left" }}>{n.title}</button></li>)}</ol>
        </>}
      </aside>
    </div>
    <div className="rl-run-summary"><span>{summary.passed}/{graph.nodes.length} nodes passed</span><span>{summary.checks}/{summary.totalChecks} checks exited 0</span><span>{summary.outputTokens.toLocaleString()} output tokens across attempts</span>{summary.hasCost && <span>${summary.costUsd.toFixed(3)} reported</span>}</div>
    {nextIds.length > 0 && <p className="rl-run-hint" aria-label="Scheduler preview">Next eligible: {nextIds.map((id) => graph.nodes.find((n) => n.id === id)?.title ?? id).join(" · ")}</p>}
    {report && <MeasuredResults report={report} onClose={() => setReport(null)} />}
  </section>;
}

interface InspectorProps {
  graph: RunGraph; node: RunNode; stream?: NodeStream; busy: boolean;
  apply: (ops: RunOp[]) => Promise<Applied | undefined>;
  intervene: (action: string, nodeId?: string, message?: string) => Promise<RunGraph | undefined>;
  onError: (message: string | null) => void;
}
function NodeInspector({ graph, node, stream, busy, apply, intervene, onError }: InspectorProps) {
  const editable = editableGraph(graph) && node.status !== "passed";
  const [draft, setDraft] = useState<RunNode>(node);
  const [scope, setScope] = useState(node.scopeHint.join("\n"));
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState("");
  const [dependency, setDependency] = useState("");
  const [mergeTarget, setMergeTarget] = useState("");
  const [diff, setDiff] = useState<DiffFile[] | null>(null);
  const [diffBusy, setDiffBusy] = useState(false);
  useEffect(() => { if (!dirty) { setDraft(node); setScope(node.scopeHint.join("\n")); } }, [node, dirty]);
  const patch = <K extends keyof RunNode>(key: K, value: RunNode[K]) => { setDirty(true); setDraft((old) => ({ ...old, [key]: value })); };
  const action = (name: string) => void intervene(name, node.id).catch(ignoreHandledError);
  const save = () => {
    const set: NodePatch = { title: draft.title, brief: draft.brief, kind: draft.kind, seat: draft.seat || null, model: draft.model || null,
      effort: draft.effort || null, scopeHint: scope.split(/[\n,]/).map((s) => s.trim()).filter(Boolean), enforceScope: draft.enforceScope,
      verifyCmd: draft.verifyCmd || null, checkGlobal: draft.checkGlobal, maxAttempts: draft.maxAttempts, planBlockId: draft.planBlockId || null };
    void apply([{ op: "update_node", id: node.id, set }]).then((result) => { if (result) setDirty(false); }).catch(ignoreHandledError);
  };
  const currentIndex = graph.nodes.findIndex((n) => n.id === node.id);
  const links = graph.edges.filter((edge) => edge.to === node.id || edge.from === node.id);
  return <>
    <h3>{node.title}</h3>
    <p className="rl-run-hint">{node.status.replace(/_/g, " ")}{node.exitCode != null ? ` · Command exit ${node.exitCode}` : ""}</p>
    <fieldset disabled={!editable || busy}>
      <label>Title<input value={draft.title} onChange={(e) => patch("title", e.target.value)} /></label>
      <label>Kind<select value={draft.kind} onChange={(e) => {
        const kind = e.target.value as NodeKind;
        setDirty(true);
        setDraft((old) => ({ ...old, kind, verifyCmd: kind === "check" ? old.verifyCmd || "npm test" : old.verifyCmd }));
      }}>{["task", "check", "review", "gate"].map((kind) => <option key={kind}>{kind}</option>)}</select></label>
      <label>Brief<textarea rows={5} value={draft.brief} onChange={(e) => patch("brief", e.target.value)} /></label>
      <label>Plan block<input value={draft.planBlockId ?? ""} placeholder="blk-…" onChange={(e) => patch("planBlockId", e.target.value)} /></label>
      {draft.kind === "task" || draft.kind === "review" ? <>
        <label>Agent seat<input value={draft.seat ?? ""} placeholder="orchestrator" onChange={(e) => patch("seat", e.target.value)} /></label>
        <label>Model<input value={draft.model ?? ""} placeholder="Seat default" onChange={(e) => patch("model", e.target.value)} /></label>
        <label>Effort<select value={draft.effort ?? ""} onChange={(e) => patch("effort", e.target.value)}><option value="">Seat default</option>{["low", "medium", "high", "xhigh", "max", "ultra"].map((effort) => <option key={effort}>{effort}</option>)}</select></label>
      </> : null}
      {draft.kind === "task" && <>
        <label>Scope hints<textarea value={scope} placeholder={"src/api/**\nsrc/lib/contracts.ts"} onChange={(e) => { setDirty(true); setScope(e.target.value); }} /></label>
        <label className="rl-run-checkbox"><input type="checkbox" checked={draft.enforceScope} onChange={(e) => patch("enforceScope", e.target.checked)} />Enforce these hints as write boundaries</label>
      </>}
      {draft.kind === "check" && <>
        <label>Check command<textarea value={draft.verifyCmd ?? ""} onChange={(e) => patch("verifyCmd", e.target.value)} /></label>
        <label className="rl-run-checkbox"><input type="checkbox" checked={draft.checkGlobal} onChange={(e) => patch("checkGlobal", e.target.checked)} />Repository-wide barrier</label>
        <p className="rl-run-hint">Turn this off only when the command checks a specific package or path. Scoped coverage follows predecessor file claims.</p>
      </>}
      <label>Maximum attempts<input type="number" min={1} max={10} value={draft.maxAttempts} onChange={(e) => patch("maxAttempts", Number(e.target.value))} /></label>
      <button className="rl-run-primary" onClick={save}>Save node</button>
    </fieldset>
    <div className="rl-run-toolbar">
      <button disabled={!editable || busy || !currentIndex} onClick={() => void apply([{ op: "move_node", id: node.id, beforeId: graph.nodes[currentIndex - 1].id }]).catch(ignoreHandledError)}>Earlier</button>
      <button disabled={!editable || busy || currentIndex === graph.nodes.length - 1} onClick={() => void apply([{ op: "move_node", id: node.id, beforeId: graph.nodes[currentIndex + 2]?.id ?? null }]).catch(ignoreHandledError)}>Later</button>
      <button disabled={!editable || busy || node.attempt > 0} onClick={() => {
        try { void apply(splitNodeOps(graph, node.id, freshId("n"))).catch(ignoreHandledError); } catch (e) { onError(String(e)); }
      }}>Split</button>
      <button className="rl-run-danger" disabled={!editable || busy || node.attempt > 0} onClick={() => void apply([{ op: "remove_node", id: node.id }]).catch(ignoreHandledError)}>Delete</button>
    </div>
    {editable && <>
      <div className="rl-run-row"><select aria-label="Merge into node" value={mergeTarget} onChange={(e) => setMergeTarget(e.target.value)}><option value="">Merge into…</option>{graph.nodes.filter((n) => n.id !== node.id && n.kind === node.kind && !n.attempt).map((n) => <option key={n.id} value={n.id}>{n.title}</option>)}</select><button disabled={!mergeTarget || busy} onClick={() => { try { void apply(mergeNodeOps(graph, node.id, mergeTarget)).catch(ignoreHandledError); } catch (e) { onError(String(e)); } }}>Merge</button></div>
      <h3>Dependencies</h3>
      {links.map((edge) => <div className="rl-run-row" key={edge.id}><span>{graph.nodes.find((n) => n.id === edge.from)?.title} → {graph.nodes.find((n) => n.id === edge.to)?.title}</span><button aria-label="Remove dependency" disabled={busy} onClick={() => void apply([{ op: "remove_edge", id: edge.id }]).catch(ignoreHandledError)}>×</button></div>)}
      <div className="rl-run-row"><select aria-label="Wait for node" value={dependency} onChange={(e) => setDependency(e.target.value)}><option value="">Wait for…</option>{graph.nodes.filter((n) => n.id !== node.id).map((n) => <option key={n.id} value={n.id}>{n.title}</option>)}</select><button disabled={!dependency || busy} onClick={() => void apply([{ op: "add_edge", edge: { id: freshId("e"), from: dependency, to: node.id, type: "blocks" } }]).catch(ignoreHandledError)}>Add</button></div>
    </>}
    {graph.status !== "draft" && <>
      <h3>Intervene</h3>
      <div className="rl-run-toolbar">
        {node.kind === "gate" && node.status === "awaiting_human" && <button className="rl-run-primary" disabled={busy} onClick={() => action("approve")}>Approve gate</button>}
        {isLiveNode(node.status) ? <button className="rl-run-danger" disabled={busy} onClick={() => action("stop")}>Stop node</button> : <>
          {node.kind !== "gate" && <button disabled={busy} onClick={() => action("retry")}>Retry</button>}
          <button disabled={busy} onClick={() => action("skip")}>Skip</button>
        </>}
      </div>
      {node.kind === "task" && <>
        <label>Follow-up<textarea value={message} onChange={(e) => setMessage(e.target.value)} placeholder="What should this node do next?" /></label>
        <div className="rl-run-row"><button disabled={busy || !message.trim() || !isLiveNode(node.status)} title="Deliver to the active turn at the next safe boundary" onClick={() => void intervene("steer", node.id, message).then(() => setMessage("")).catch(ignoreHandledError)}>Steer</button><button disabled={busy || !message.trim()} title="Run this message after the current turn" onClick={() => void intervene("queue", node.id, message).then(() => setMessage("")).catch(ignoreHandledError)}>Queue</button></div>
        {node.queuedMessages.length > 0 && <p className="rl-run-hint">{node.queuedMessages.length} queued follow-up{node.queuedMessages.length === 1 ? "" : "s"}</p>}
      </>}
      <p className="rl-run-hint">To reassign the seat or model, pause scheduling and wait for active nodes to finish. Retry a passed node before editing it.</p>
    </>}
    <h3 style={{ marginTop: 16 }}>Node output</h3>
    <pre className="rl-run-output">{stream?.partial || node.output || "No output yet."}</pre>
    <button disabled={diffBusy || node.attempt === 0} onClick={() => {
      setDiffBusy(true);
      void invoke<DiffFile[]>("runner_node_diff", { runId: graph.runId, nodeId: node.id }).then(setDiff).catch((e) => onError(String(e))).finally(() => setDiffBusy(false));
    }}>{diffBusy ? "Reading changes…" : "Inspect claimed files"}</button>
    {diff && <div style={{ marginTop: 10 }}><p className="rl-run-hint">Current working-tree changes on this node’s claimed paths. These may include changes already present before the run.</p>
      {diff.length === 0 && <p className="rl-run-hint">No current diff on claimed paths.</p>}
      {diff.map((file) => <details key={`${file.oldPath}:${file.newPath}`}><summary>{file.newPath || file.oldPath} · {file.status}</summary>
        {file.binary ? <p>Binary file</p> : <pre className="rl-run-output">{file.hunks.flatMap((hunk) => hunk.lines).slice(0, 400).map((line) => `${line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}${line.text}`).join("\n")}{file.hunks.reduce((count, hunk) => count + hunk.lines.length, 0) > 400 ? "\n… Open Review changes for the full diff." : ""}</pre>}
      </details>)}
    </div>}
  </>;
}

interface MeasuredReport { measured: boolean; summary: string; subtasks: { nodeId: string; title: string; verified: boolean; skipped: boolean; attempts: number; checks: { nodeId: string; command?: string; status: string; exitCode?: number | null }[] }[] }
function MeasuredResults({ report, onClose }: { report: MeasuredReport; onClose: () => void }) {
  return <div><div className="rl-run-toolbar"><strong>Measured results</strong><button onClick={onClose}>Close report</button></div>
    <p className="rl-run-hint">{report.summary}. Verification is derived from completed checks and independent reviews.</p>
    <table className="rl-run-report"><thead><tr><th>Task</th><th>Result</th><th>Attempts</th><th>Checks</th></tr></thead><tbody>{report.subtasks.map((task) => <tr key={task.nodeId}><td>{task.title}</td><td>{task.skipped ? "Skipped" : task.verified ? "Verified" : "Unverified"}</td><td>{task.attempts}</td><td>{task.checks.map((check) => `${check.command ?? check.nodeId}: ${check.exitCode != null ? `exit ${check.exitCode}` : check.status}`).join("; ") || "No checks"}</td></tr>)}</tbody></table>
  </div>;
}
