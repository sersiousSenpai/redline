// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { MermaidView } from "../editor/extensions/MermaidView";
import { MarkdownView } from "./MarkdownView";
import { LoopCheckpointCard } from "./LoopCheckpointCard";
import { RUN_LEVEL, type LoopBeat, type UseLoop } from "../hooks/useLoop";
import type { LoopAttempt, LoopRun, LoopSubtask } from "../types";

/** A heartbeat older than this reads as "stale" — the turn may be wedged. */
const BEAT_STALE_MS = 9_000;

/** "2m 14s" / "0:47" style compact elapsed. */
function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return m > 0 ? `${m}m ${rem.toString().padStart(2, "0")}s` : `${rem}s`;
}

interface LoopTrajectoryProps {
  loop: UseLoop;
  onClose: () => void;
}

/** The Loop Orchestrator pane: the run header (status + cancel/analyze), the
 *  pending decision gates up top, a strict-mode mermaid flowchart of the subtask
 *  DAG, the subtask cards, and — when a card is selected — that subtask's live
 *  transcript. Sibling of MissionChat, on the `loop-*` event family. */
export function LoopTrajectory({ loop, onClose }: LoopTrajectoryProps) {
  const {
    runs,
    activeRun,
    activeRunId,
    snapshot,
    transcripts,
    beats,
    error,
    resumeRun,
    cancelLoop,
    deleteLoop,
    analyzeLoop,
    decideCheckpoint,
  } = loop;

  const subtasks = snapshot?.subtasks ?? [];
  const pendingCheckpoints = (snapshot?.checkpoints ?? []).filter(
    (c) => c.status === "pending",
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const selected = subtasks.find((t) => t.subtaskId === selectedId) ?? null;
  const dag = useMemo(() => buildDag(subtasks), [subtasks]);

  // The live transcript of the selected subtask sticks to the bottom while it
  // streams (same behaviour as MissionChat's chat log).
  const transcript = selectedId ? (transcripts[selectedId] ?? "") : "";
  const transcriptRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [transcript]);

  if (!activeRun) {
    return (
      <div
        className="flex flex-col h-full min-h-0"
        style={{ background: "var(--color-paper)", borderLeft: "1px solid var(--color-rule)" }}
      >
        <RunHeader
          run={null}
          runs={runs}
          activeRunId={activeRunId}
          onResume={resumeRun}
          onCancel={cancelLoop}
          onDelete={deleteLoop}
          onAnalyze={analyzeLoop}
          onClose={onClose}
        />
        <div
          className="flex-1 flex items-center justify-center px-6 text-center"
          style={{ fontSize: "12px", color: "var(--color-ink-muted)", lineHeight: 1.5 }}
        >
          No orchestrator run yet. Approve a plan, then hit{" "}
          <strong>Run with Loop Orchestrator</strong> to decompose it into
          subtasks and drive them to a landed result.
        </div>
      </div>
    );
  }

  return (
    <div
      className="flex flex-col h-full min-h-0"
      style={{ background: "var(--color-paper)", borderLeft: "1px solid var(--color-rule)" }}
    >
      <RunHeader
        run={activeRun}
        runs={runs}
        activeRunId={activeRunId}
        onResume={resumeRun}
        onCancel={cancelLoop}
        onDelete={deleteLoop}
        onAnalyze={analyzeLoop}
        onClose={onClose}
      />

      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-y-auto rl-thin-scroll-y flex flex-col gap-3 px-3 py-3"
      >
        {error && (
          <div
            className="rounded px-2 py-1.5"
            style={{ fontSize: "11.5px", color: "var(--color-warning)", background: "var(--color-bg-elevated)", border: "1px solid var(--color-rule)" }}
          >
            {error}
          </div>
        )}

        {pendingCheckpoints.length > 0 && (
          <div className="flex flex-col gap-2">
            <SectionLabel>Decision gates ({pendingCheckpoints.length})</SectionLabel>
            {pendingCheckpoints.map((cp) => (
              <LoopCheckpointCard
                key={cp.checkpointId}
                checkpoint={cp}
                subtask={
                  cp.subtaskId
                    ? subtasks.find((t) => t.subtaskId === cp.subtaskId) ?? null
                    : null
                }
                onDecide={decideCheckpoint}
              />
            ))}
          </div>
        )}

        {dag ? (
          <div className="flex flex-col gap-1">
            <SectionLabel>Task graph</SectionLabel>
            <MermaidView code={dag} />
          </div>
        ) : (
          subtasks.length === 0 &&
          (activeRun.status === "planning" ? (
            <PlanningPanel
              run={activeRun}
              transcript={transcripts[RUN_LEVEL] ?? ""}
              beat={beats[RUN_LEVEL]}
            />
          ) : (
            <div style={{ fontSize: "12px", color: "var(--color-ink-muted)", lineHeight: 1.5 }}>
              No subtasks yet.
            </div>
          ))
        )}

        {subtasks.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <SectionLabel>Subtasks ({subtasks.length})</SectionLabel>
            {[...subtasks]
              .sort((a, b) => a.seq - b.seq)
              .map((t) => (
                <SubtaskCard
                  key={t.subtaskId}
                  subtask={t}
                  selected={t.subtaskId === selectedId}
                  onSelect={() =>
                    setSelectedId((cur) =>
                      cur === t.subtaskId ? null : t.subtaskId,
                    )
                  }
                />
              ))}
          </div>
        )}
      </div>

      {selected && (
        <TranscriptPanel
          key={selected.subtaskId}
          subtask={selected}
          transcript={transcript}
          transcriptRef={transcriptRef}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  );
}

/** The PLANNING-state card: a live elapsed timer + liveness dot driven by the
 *  planner turn's heartbeat, and the planner's streaming output (previously
 *  captured but never shown) so a slow decomposition is visibly *working*
 *  rather than an opaque "Planning…" that could equally mean "wedged". */
function PlanningPanel({
  run,
  transcript,
  beat,
}: {
  run: LoopRun;
  transcript: string;
  beat: LoopBeat | undefined;
}) {
  // Re-render every second so the timer and staleness read stay smooth between
  // the (coarser) backend heartbeats.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Prefer the turn's own elapsed (from the last heartbeat, smoothed forward);
  // fall back to the run's creation time before the first beat arrives.
  const elapsedMs = beat
    ? beat.elapsedMs + (now - beat.receivedAt)
    : now - run.createdAt;
  const sinceBeat = beat ? now - beat.receivedAt : Infinity;
  const live = sinceBeat < BEAT_STALE_MS;

  const streamRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = streamRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [transcript]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span
          className="rounded-full"
          title={live ? "Planner is alive" : "No heartbeat recently — may be stalled"}
          style={{
            width: "7px",
            height: "7px",
            flexShrink: 0,
            background: live ? "var(--color-success)" : "var(--color-warning)",
            boxShadow: live ? "0 0 4px var(--color-success)" : "none",
          }}
        />
        <span style={{ fontSize: "12px", color: "var(--color-ink)", lineHeight: 1.4 }}>
          Planning — decomposing the plan into subtasks…
        </span>
        <span
          className="ml-auto font-mono tabular-nums"
          style={{ fontSize: "11px", color: "var(--color-ink-muted)" }}
        >
          {fmtElapsed(elapsedMs)}
        </span>
      </div>
      {!live && beat && (
        <div style={{ fontSize: "10.5px", color: "var(--color-warning)", lineHeight: 1.4 }}>
          No output for a while — if this persists the run will fail on its own,
          or you can Cancel.
        </div>
      )}
      {transcript.trim() && (
        <div
          ref={streamRef}
          className="rounded font-mono rl-thin-scroll-y"
          style={{
            fontSize: "10.5px",
            lineHeight: 1.45,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            color: "var(--color-ink-muted)",
            background: "var(--color-bg-elevated)",
            border: "1px solid var(--color-rule)",
            padding: "6px 8px",
            maxHeight: "220px",
            overflowY: "auto",
          }}
        >
          {transcript}
        </div>
      )}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        fontSize: "10px",
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: "0.06em",
        color: "var(--color-ink-muted)",
      }}
    >
      {children}
    </span>
  );
}

function RunHeader({
  run,
  runs,
  activeRunId,
  onResume,
  onCancel,
  onDelete,
  onAnalyze,
  onClose,
}: {
  run: LoopRun | null;
  runs: LoopRun[];
  activeRunId: string | null;
  onResume: (runId: string) => void;
  onCancel: (runId: string) => void;
  onDelete: (runId: string) => void;
  onAnalyze: (runId: string) => void;
  onClose: () => void;
}) {
  const active = run?.status === "running" || run?.status === "planning";
  const confirmDelete = (r: LoopRun) => {
    const verb = r.status === "planning" || r.status === "running"
      ? "Cancel and delete"
      : "Delete";
    if (
      window.confirm(
        `${verb} “${r.title}”? This kills any running work, prunes its worktrees and integration branch, and removes the run. Your base branch is untouched.`,
      )
    ) {
      onDelete(r.runId);
    }
  };
  return (
    <div
      className="flex items-center gap-1.5 px-3 py-2 shrink-0"
      style={{ borderBottom: "1px solid var(--color-rule)" }}
    >
      <span style={{ fontSize: "13px", lineHeight: "16px" }}>🔁</span>
      <div className="flex flex-col min-w-0 flex-1">
        <span
          className="truncate"
          style={{ fontSize: "12px", fontWeight: 600, color: "var(--color-ink)" }}
          title={run?.title}
        >
          {run?.title ?? "Loop Orchestrator"}
        </span>
        {run && (
          <span style={{ fontSize: "10px", color: "var(--color-ink-muted)" }} className="truncate">
            {run.baseRef} → {run.integrationBranch}
          </span>
        )}
      </div>
      {run && <RunStatusPill status={run.status} />}
      {runs.length > 1 && (
        <select
          value={activeRunId ?? ""}
          onChange={(e) => onResume(e.target.value)}
          title="Switch run"
          className="rounded"
          style={{
            fontSize: "10px",
            maxWidth: "84px",
            border: "1px solid var(--color-rule)",
            background: "var(--color-bg-elevated)",
            color: "var(--color-ink)",
          }}
        >
          {runs.map((r) => (
            <option key={r.runId} value={r.runId}>
              {r.title}
            </option>
          ))}
        </select>
      )}
      {run && active && (
        <button
          type="button"
          onClick={() => onCancel(run.runId)}
          title="Cancel this run"
          className="px-1 leading-none opacity-70 hover:opacity-100"
          style={{ fontSize: "11px", color: "var(--color-warning)" }}
        >
          Cancel
        </button>
      )}
      {run && (run.status === "done" || run.status === "review") && (
        <button
          type="button"
          onClick={() => onAnalyze(run.runId)}
          title="Analyze this run"
          className="px-1 leading-none opacity-70 hover:opacity-100"
          style={{ fontSize: "11px", color: "var(--color-info)" }}
        >
          Analyze
        </button>
      )}
      {run && (
        <button
          type="button"
          onClick={() => confirmDelete(run)}
          title="Delete this run"
          className="px-1 leading-none opacity-60 hover:opacity-100"
          style={{ fontSize: "12px", color: "var(--color-ink-muted)" }}
        >
          🗑
        </button>
      )}
      <button
        type="button"
        onClick={onClose}
        title="Close"
        className="px-1 leading-none opacity-60 hover:opacity-100"
        style={{ fontSize: "13px", color: "var(--color-ink-muted)" }}
      >
        ✕
      </button>
    </div>
  );
}

function RunStatusPill({ status }: { status: LoopRun["status"] }) {
  const color = RUN_STATUS_COLOR[status] ?? "var(--color-ink-muted)";
  return (
    <span
      className="rounded-full px-1.5 py-0.5"
      style={{
        fontSize: "9px",
        fontWeight: 700,
        textTransform: "uppercase",
        letterSpacing: "0.05em",
        color: "var(--color-on-accent)",
        background: color,
      }}
    >
      {status.replace(/_/g, " ")}
    </span>
  );
}

const RUN_STATUS_COLOR: Record<LoopRun["status"], string> = {
  planning: "var(--color-info)",
  running: "var(--color-info)",
  paused_checkpoint: "var(--color-warning)",
  review: "var(--color-warning)",
  done: "var(--color-success)",
  failed: "var(--color-warning)",
  cancelled: "var(--color-ink-muted)",
};

const SUBTASK_STATUS_COLOR: Record<LoopSubtask["status"], string> = {
  pending: "var(--color-ink-muted)",
  blocked: "var(--color-ink-muted)",
  running: "var(--color-info)",
  reviewing: "var(--color-info)",
  needs_changes: "var(--color-warning)",
  awaiting_merge: "var(--color-warning)",
  merged: "var(--color-success)",
  stuck: "var(--color-warning)",
  failed: "var(--color-warning)",
  skipped: "var(--color-ink-muted)",
};

function SubtaskCard({
  subtask,
  selected,
  onSelect,
}: {
  subtask: LoopSubtask;
  selected: boolean;
  onSelect: () => void;
}) {
  const color = SUBTASK_STATUS_COLOR[subtask.status] ?? "var(--color-ink-muted)";
  return (
    <button
      type="button"
      onClick={onSelect}
      className="rounded px-2 py-1.5 text-left"
      style={{
        border: `1px solid ${selected ? "var(--color-info)" : "var(--color-rule)"}`,
        background: selected ? "var(--color-anchor-bg)" : "var(--color-bg-elevated)",
        cursor: "pointer",
      }}
    >
      <div className="flex items-center gap-1.5">
        <span
          className="rounded-full px-1.5 py-0.5 shrink-0"
          style={{
            fontSize: "8.5px",
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: "0.04em",
            color: "var(--color-on-accent)",
            background: color,
          }}
        >
          {subtask.status.replace(/_/g, " ")}
        </span>
        <span
          className="truncate flex-1"
          style={{ fontSize: "12px", fontWeight: 600, color: "var(--color-ink)" }}
          title={subtask.title}
        >
          {subtask.seq}. {subtask.title}
        </span>
        {subtask.irreversible && (
          <span title="Irreversible operation" style={{ fontSize: "11px" }}>⚠️</span>
        )}
      </div>
      <div
        className="flex items-center gap-2 mt-0.5"
        style={{ fontSize: "9.5px", color: "var(--color-ink-muted)" }}
      >
        <span>
          {subtask.attempts} attempt{subtask.attempts === 1 ? "" : "s"}
        </span>
        {subtask.branch && (
          <span className="font-mono truncate" title={subtask.branch}>
            ⑂ {subtask.branch}
          </span>
        )}
        {subtask.touchedPaths.length > 0 && (
          <span title={subtask.touchedPaths.join("\n")}>
            {subtask.touchedPaths.length} file
            {subtask.touchedPaths.length === 1 ? "" : "s"}
          </span>
        )}
      </div>
    </button>
  );
}

function TranscriptPanel({
  subtask,
  transcript,
  transcriptRef,
  onClose,
}: {
  subtask: LoopSubtask;
  transcript: string;
  transcriptRef: React.RefObject<HTMLDivElement | null>;
  onClose: () => void;
}) {
  // Lazily pull this subtask's attempts (executor/reviewer passes, verdicts,
  // diff stats) — the durable record behind the live stream.
  const [attempts, setAttempts] = useState<LoopAttempt[]>([]);
  useEffect(() => {
    let alive = true;
    void invoke<LoopAttempt[]>("loop_subtask_attempts", {
      subtaskId: subtask.subtaskId,
    })
      .then((rows) => {
        if (alive) setAttempts(rows);
      })
      .catch(() => {
        if (alive) setAttempts([]);
      });
    return () => {
      alive = false;
    };
  }, [subtask.subtaskId, subtask.attempts, subtask.status]);

  const latestDiff = [...attempts].reverse().find((a) => a.diffStat)?.diffStat;

  return (
    <div
      className="shrink-0 flex flex-col"
      style={{ borderTop: "1px solid var(--color-rule)", maxHeight: "45%" }}
    >
      <div
        className="flex items-center gap-1.5 px-3 py-1.5 shrink-0"
        style={{ borderBottom: "1px solid var(--color-rule)" }}
      >
        <span
          className="truncate flex-1"
          style={{ fontSize: "11px", fontWeight: 600, color: "var(--color-ink)" }}
        >
          {subtask.seq}. {subtask.title}
        </span>
        {latestDiff && (
          <span className="font-mono" style={{ fontSize: "10px", color: "var(--color-ink-muted)" }}>
            {latestDiff}
          </span>
        )}
        <button
          type="button"
          onClick={onClose}
          className="px-1 leading-none opacity-60 hover:opacity-100"
          style={{ fontSize: "12px", color: "var(--color-ink-muted)" }}
        >
          ✕
        </button>
      </div>
      <div
        ref={transcriptRef}
        className="flex-1 min-h-0 overflow-y-auto rl-thin-scroll-y px-3 py-2 flex flex-col gap-2"
      >
        {attempts.length > 0 && (
          <div className="flex flex-col gap-1">
            {attempts.map((a) => (
              <div
                key={a.attemptId}
                className="flex items-center gap-1.5"
                style={{ fontSize: "10px", color: "var(--color-ink-muted)" }}
              >
                <span
                  style={{
                    fontWeight: 600,
                    textTransform: "uppercase",
                    letterSpacing: "0.04em",
                  }}
                >
                  #{a.attemptNo} {a.role}
                </span>
                {a.verdict && (
                  <span
                    style={{
                      color:
                        a.verdict === "pass"
                          ? "var(--color-success)"
                          : "var(--color-warning)",
                    }}
                  >
                    {a.verdict}
                    {a.score != null ? ` · ${a.score}` : ""}
                  </span>
                )}
                {a.diffStat && (
                  <span className="font-mono truncate" title={a.diffStat}>
                    {a.diffStat}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
        {transcript ? (
          <MarkdownView body={transcript} compact />
        ) : (
          <div style={{ fontSize: "11.5px", color: "var(--color-ink-muted)", lineHeight: 1.5 }}>
            {subtask.status === "running" || subtask.status === "reviewing"
              ? "Streaming…"
              : "No live transcript for this subtask yet."}
          </div>
        )}
      </div>
    </div>
  );
}

/** Build a strict-mode mermaid flowchart of the subtask DAG. Node ids are
 *  synthetic (`n{index}`) so the opaque subtaskIds never leak into the diagram
 *  source; edges come from each subtask's `deps`. Returns null when there are no
 *  subtasks to draw. */
function buildDag(subtasks: LoopSubtask[]): string | null {
  if (subtasks.length === 0) return null;
  const idOf = new Map<string, string>();
  subtasks.forEach((t, i) => idOf.set(t.subtaskId, `n${i}`));
  const lines: string[] = ["flowchart TD"];
  for (const t of subtasks) {
    const nid = idOf.get(t.subtaskId)!;
    lines.push(`  ${nid}["${nodeLabel(t)}"]`);
  }
  for (const t of subtasks) {
    const nid = idOf.get(t.subtaskId)!;
    for (const dep of t.deps) {
      const from = idOf.get(dep);
      if (from) lines.push(`  ${from} --> ${nid}`);
    }
  }
  return lines.join("\n");
}

const STATUS_MARK: Partial<Record<LoopSubtask["status"], string>> = {
  merged: "✓",
  running: "…",
  reviewing: "…",
  stuck: "!",
  failed: "✗",
  skipped: "–",
};

/** A DAG node label, safe for mermaid's double-quoted node text (no embedded
 *  quotes, brackets or newlines that would break strict-mode parsing). */
function nodeLabel(t: LoopSubtask): string {
  const mark = STATUS_MARK[t.status] ?? "";
  const title = t.title
    .replace(/["'`]/g, "")
    .replace(/[[\]{}()]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
  return `${t.seq}. ${title}${mark ? ` ${mark}` : ""}`;
}
