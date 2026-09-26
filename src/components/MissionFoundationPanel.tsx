// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useEffect, useState } from "react";
import { useMissionFoundation } from "../hooks/useMissionFoundation";
import { MissionCapturePlayer } from "./MissionCapturePlayer";
import { MISSION_CONTEXT_SCOPE, SECURITIES_DEV_HOSTS, SECURITIES_DEV_MANDATE, type HandoffDestination, type MissionHandoff, type MissionQuestion } from "../lib/missionFoundation";
import "./MissionFoundationPanel.css";

interface Props {
  missionId: string;
  tabIds?: string[];
  initialBrief?: string;
  onOpenDraft?: (draftId: string) => void;
  onContinue?: (destination: "plan" | "auto", body: string, handoffId: string) => void;
}

function Question({ question, disabled, resolve }: { question: MissionQuestion; disabled: boolean;
  resolve: (action: string, explanation: string) => void }) {
  const [explanation, setExplanation] = useState("");
  return <article className="mission-foundation-question">
    <strong>{question.question}</strong>
    {question.body && <p>{question.body}</p>}
    {question.url && <a href={question.url} target="_blank" rel="noreferrer">Open source</a>}
    <small>{new Date(question.observedAt).toLocaleString()} · {question.status}</small>
    {question.uncertainty && <small>{question.uncertainty}</small>}
    <textarea aria-label="Your judgment or correction" placeholder="Explain what future research should learn…" value={explanation} onChange={e => setExplanation(e.target.value)} rows={2}/>
    <div className="mission-foundation-actions">
      {(["confirm", "correct", "defer", "dismiss"] as const).map(action => <button type="button" key={action}
        disabled={disabled || (["confirm", "correct"].includes(action) && !explanation.trim())}
        onClick={() => resolve(action, explanation)}>{action[0].toUpperCase() + action.slice(1)}</button>)}
    </div>
  </article>;
}

export function MissionFoundationPanel({ missionId, tabIds = [], initialBrief = "", onOpenDraft, onContinue }: Props) {
  const { state, error, busy, act, refresh } = useMissionFoundation(missionId);
  const [section, setSection] = useState<"knowledge" | "bots" | "review" | "capture" | "continue">("knowledge");
  const [botName, setBotName] = useState("");
  const [mandate, setMandate] = useState("");
  const [hosts, setHosts] = useState("");
  const [cadence, setCadence] = useState("daily");
  const [contextMode, setContextMode] = useState("follow");
  const [scope, setScope] = useState<string[]>([...MISSION_CONTEXT_SCOPE]);
  const [localOnly, setLocalOnly] = useState(true);
  const [destination, setDestination] = useState<HandoffDestination>("drafter");
  const [brief, setBrief] = useState(initialBrief);
  const [excludedHosts, setExcludedHosts] = useState<string | null>(null);
  const [captureTabs, setCaptureTabs] = useState<string[] | null>(null);
  const [openCapture, setOpenCapture] = useState<string | null>(null);
  const [prepared, setPrepared] = useState<MissionHandoff | null>(null);
  const pending = (state?.questions ?? []).filter(q => q.status === "open" || q.status === "deferred").sort((a, b) => b.priority - a.priority);
  const latest = state?.versions[0];
  const policy = state?.capturePolicy;
  useEffect(() => {
    setPrepared(null); setBrief(initialBrief); setBotName(""); setMandate(""); setHosts("");
    setCaptureTabs(null); setExcludedHosts(null); setOpenCapture(null);
  }, [missionId, initialBrief]);
  const createBot = () => act({ op: "createBot", definition: {
    name: botName, mandate, cadence, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    contextMode, versionId: latest?.versionId, contextScope: scope, allowedTools: ["read", "fetch", "snapshot"],
    allowedHosts: hosts.split(/[\s,]+/).map(h => h.trim()).filter(Boolean), localOnly,
  } });
  const saveCapture = (enabled: boolean, paused: boolean) => act({ op: "configureCapture", policy: {
    enabled, paused, tabIds: captureTabs ?? policy?.tabIds ?? [],
    excludedHosts: excludedHosts !== null ? excludedHosts.split(/[\s,]+/).filter(Boolean) : policy?.excludedHosts ?? [],
    maxDurationMs: 7_000, maxBytes: 64 * 1024 * 1024, retentionMs: 7 * 24 * 60 * 60 * 1000, localOnly: true,
  } });
  const deliver = async (selected: MissionHandoff) => {
    const handoff = selected.body ? selected : await act<MissionHandoff>({ op: "getHandoff", handoffId: selected.id });
    if (!handoff) return;
    if (handoff.destination === "drafter" && onOpenDraft) {
      onOpenDraft(handoff.draftId);
      await act({ op: "deliverHandoff", handoffId: handoff.id, destinationId: handoff.draftId });
    } else if (handoff.destination !== "drafter") onContinue?.(handoff.destination, handoff.body, handoff.id);
  };
  return <section className="mission-foundation" aria-label="Mission knowledge and monitoring">
    <header><strong>Mission workspace</strong><span>{state?.runtime?.status.split("_").join(" ") ?? "Loading…"}</span><button type="button" onClick={() => void refresh()} disabled={busy}>Refresh</button></header>
    {state?.runtime?.nextAction && <p className="mission-foundation-next">{state.runtime.nextAction}</p>}
    {(error || state?.runtime?.error) && <p role="alert" className="mission-foundation-error">{error || state?.runtime?.error}</p>}
    <nav aria-label="Mission workspace sections">{(["knowledge", "bots", "review", "capture", "continue"] as const).map(s => <button key={s} type="button" aria-pressed={section === s} onClick={() => setSection(s)}>{s === "review" ? `Review${pending.length ? ` (${pending.length})` : ""}` : s === "continue" ? "Continue as…" : s[0].toUpperCase() + s.slice(1)}</button>)}</nav>
    {section === "knowledge" && <div className="mission-foundation-body">
      <p>Publish an immutable version of the mission’s evidence, artifact, procedure, and confirmed decisions. Each monitoring run keeps the version it starts with.</p>
      <fieldset><legend>Included context</legend>{MISSION_CONTEXT_SCOPE.map(part => <label key={part}><input type="checkbox" checked={scope.includes(part)} onChange={e => setScope(old => e.target.checked ? [...old, part] : old.filter(p => p !== part))}/>{part === "runHistory" ? "Run history" : part}</label>)}</fieldset>
      <label><input type="checkbox" checked={localOnly} onChange={e => setLocalOnly(e.target.checked)}/> Keep this context on local models</label>
      <button type="button" disabled={busy || !scope.length} onClick={() => void act({ op: "publish", scope, localOnly })}>Publish context version</button>
      {state?.versions.map((v, index) => <article key={v.versionId}><strong>{index === 0 ? "Latest version" : "Published version"}</strong><small>{new Date(v.publishedAt).toLocaleString()} · {v.localOnly ? "Local only" : "Configured model providers"}</small><code title={v.manifestHash}>{v.manifestHash.slice(0, 20)}…</code><small>{v.includedScope.join(", ")}</small></article>)}
    </div>}
    {section === "bots" && <div className="mission-foundation-body">
      <p>Define monitoring work for a compatible runtime. Each run records its model, computer, evidence, coverage, and checkpoints.</p>
      <button type="button" onClick={() => { setBotName("Securities Dev"); setMandate(SECURITIES_DEV_MANDATE); setHosts(SECURITIES_DEV_HOSTS.join("\n")); setCadence("daily"); }}>Use Securities Dev reference (12 firms)</button>
      {!latest && <p>Publish a context version before creating a bot.</p>}
      <label>Bot name<input value={botName} onChange={e => setBotName(e.target.value)} placeholder="Securities Dev"/></label>
      <label>Monitoring mandate<textarea rows={3} value={mandate} onChange={e => setMandate(e.target.value)} placeholder="What should this bot monitor, and why does it matter?"/></label>
      <label>Permitted source hosts<textarea rows={2} value={hosts} onChange={e => setHosts(e.target.value)} placeholder="One exact hostname per line"/></label>
      <label>Cadence<select value={cadence} onChange={e => setCadence(e.target.value)}><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="manual">Manual</option></select></label>
      <label>Context version<select value={contextMode} onChange={e => setContextMode(e.target.value)}><option value="follow">Follow new published versions</option><option value="pinned">Pin the current version</option></select></label>
      <small>Permitted actions: read sources, fetch pages, and capture selected pages. Context scope and local model preference follow the Knowledge selection. Scheduling requires a connected runtime.</small>
      <button type="button" disabled={busy || !latest || !botName.trim() || !mandate.trim() || !hosts.trim()} onClick={() => void createBot()}>Create monitoring bot</button>
      {state?.bots.map(bot => <article key={bot.id}><strong>{bot.name}</strong><p>{bot.mandate}</p><small>{bot.cadence} · {bot.contextMode === "follow" ? "Follows published context" : "Pinned context"}</small></article>)}
      {state?.runs.map(run => <small key={run.id}>{run.status} · {new Date(run.startedAt).toLocaleString()} · {run.versionId.slice(0, 8)}</small>)}
    </div>}
    {section === "review" && <div className="mission-foundation-body"><p>Confirm meaning explicitly. Deferring keeps uncertainty; dismissing a question does not reject its source.</p>{pending.length === 0 && <p>No questions are awaiting review.</p>}{pending.slice(0, 12).map(question => <Question key={question.id} question={question} disabled={busy} resolve={(action, explanation) => void act({ op: "resolveQuestion", questionId: question.id, action, explanation, supersedes: question.resolutionId ?? null })}/>)}</div>}
    {section === "capture" && <div className="mission-foundation-body">
      <p><strong>{policy?.enabled ? policy.paused ? "Capture paused" : "Capture enabled" : "Capture disabled"}</strong></p>
      <p>Record selected visible pages around navigation and pins: up to eight still frames over seven seconds. Text recognition and descriptions of visible text stay on this Mac. Recordings have a 64 MB budget and seven-day retention.</p>
      <fieldset><legend>Capture only these tabs</legend>{tabIds.map((id, i) => <label key={id}><input type="checkbox" checked={(captureTabs ?? policy?.tabIds ?? []).includes(id)} onChange={e => setCaptureTabs(old => { const prior = old ?? policy?.tabIds ?? []; return e.target.checked ? [...prior, id] : prior.filter(t => t !== id); })}/>Tab {i + 1} <code>{id.slice(0, 8)}</code></label>)}</fieldset>
      <label>Excluded hosts<textarea value={excludedHosts ?? policy?.excludedHosts.join("\n") ?? ""} onChange={e => setExcludedHosts(e.target.value)} placeholder="Excluded domains, including their subdomains"/></label>
      <small>Global exclusions apply before every frame. Moving away from a page stops its recording. Local text recognition runs in the background; paused work resumes from saved frames.</small>
      <div className="mission-foundation-actions"><button type="button" disabled={busy} onClick={() => void saveCapture(true, false)}>Enable</button><button type="button" disabled={busy || !policy?.enabled} onClick={() => void saveCapture(true, !policy?.paused)}>{policy?.paused ? "Resume" : "Pause"}</button><button type="button" disabled={busy} onClick={() => void saveCapture(false, false)}>Disable</button><button type="button" disabled={busy} onClick={() => void act({ op: "pruneCaptures" })}>Prune expired references</button></div>
      <small>{state?.captures.filter(c => ["queued", "capturing", "processing"].includes(c.status)).length ?? 0} recording or processing · {state?.captures.filter(c => c.status === "indexed").length ?? 0} ready</small>
      {state?.captures.slice(0, 20).map(capture => <article key={capture.id}><strong>{capture.frameCount ?? 1} frame{capture.frameCount === 1 ? "" : "s"} · {capture.status}</strong><small>{capture.startedAt ? new Date(capture.startedAt).toLocaleString() : "Saved capture"} · {Math.ceil(capture.byteSize / 1024)} KB</small>{capture.url && <small>{capture.url}</small>}<button type="button" aria-expanded={openCapture === capture.id} onClick={() => setOpenCapture(current => current === capture.id ? null : capture.id)}>{openCapture === capture.id ? "Close recording" : "Review recording"}</button>{openCapture === capture.id && <MissionCapturePlayer key={`${missionId}:${capture.id}`} missionId={missionId} captureId={capture.id}/>}</article>)}
    </div>}
    {section === "continue" && <div className="mission-foundation-body">
      <label>Destination<select value={destination} onChange={e => { setDestination(e.target.value as HandoffDestination); setPrepared(null); }}><option value="drafter">Prompt Drafter</option><option value="plan">AI model plan</option><option value="auto">Auto session</option></select></label>
      <label>Editable brief<textarea rows={10} value={brief} onChange={e => { setBrief(e.target.value); setPrepared(null); }} placeholder="Objective, confirmed decisions, constraints, requirements, evidence, open questions, and acceptance criteria…"/></label>
      <small>The source conversation, linked findings, and exact artifact revision stay attached. Model and project choices use the existing launch flow.</small>
      <button type="button" disabled={busy || !brief.trim()} onClick={() => void act<MissionHandoff>({ op: "prepareHandoff", destination, body: brief, messageIds: [], idempotencyKey: crypto.randomUUID() }).then(result => { if (result) setPrepared(result); })}>Prepare source-linked brief</button>
      {prepared && <button type="button" disabled={busy || (prepared.destination === "drafter" ? !onOpenDraft : !onContinue)} onClick={() => void deliver(prepared)}>Continue to {prepared.destination === "drafter" ? "Drafter" : prepared.destination === "plan" ? "model plan" : "auto session"}</button>}
      {state?.handoffs.map(handoff => <article key={handoff.id}><strong>{handoff.destination} · {handoff.status}</strong><small>{new Date(handoff.createdAt).toLocaleString()}</small><button type="button" disabled={handoff.destination === "drafter" ? !onOpenDraft : !onContinue} onClick={() => void deliver(handoff)}>{handoff.status === "delivered" ? "Open handoff" : "Continue prepared brief"}</button></article>)}
    </div>}
  </section>;
}
