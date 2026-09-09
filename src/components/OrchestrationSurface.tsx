// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

// The Orchestration Monitor — the "Runs" main surface. When an approved plan
// is launched via Orchestrate, the orchestrator executes it as a multi-agent
// Workflow whose only prior visibility was raw terminal bytes; this surface
// renders the run live: a summary header, the phase plan, one tile per
// agent (with liveness from the run journal), and a streaming per-agent
// transcript drawer. Shell primitives copied from MemorySurface (the house
// copy-paste convention); card anatomy from ServersPane. Everything
// heuristic is marked (`~` on guessed labels, muted notes) — the monitor
// never pretends derived facts are authoritative.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { X } from "lucide-react";
import type {
  AgentTailEvent,
  AgentTile,
  OrchestrationRow,
  RunSnapshot,
  SessionSummary,
  WorkGraph,
  WorkItem,
} from "../types";
import {
  useAgentTail,
  useOrchestration,
  useOrchestrationRuns,
} from "../hooks/useOrchestration";
import {
  agentStalled,
  fileConflicts,
  formatTokens,
  groupWorkByProject,
  isLiveRunState,
  isSequentialFallback,
  runConflictCount,
  SEQUENTIAL_FALLBACK_NOTE,
  orderRuns,
  phaseProgress,
  runElapsed,
  runOutcomeLabel,
  runStatusSentence,
  tileElapsed,
  tileTitle,
  workBlockedByCounts,
  workOriginLabel,
  workStatusLabel,
} from "../lib/orchestration";
import { EmptyState } from "./EmptyState";
import type { TabRequest } from "../lib/navTarget";
import { useRunGraphList } from "../hooks/useRunGraph";
import { RunGraphPane } from "./runner/RunGraphPane";

/** Agent Seats' pill chip, copied — `chipStyle(true)` doubles as primary. */
function chipStyle(active: boolean): React.CSSProperties {
  return {
    fontSize: "10px",
    padding: "2px 7px",
    borderRadius: "999px",
    cursor: "pointer",
    whiteSpace: "nowrap",
    border: active
      ? "1px solid color-mix(in srgb, var(--color-info) 55%, var(--color-rule))"
      : "1px solid var(--color-rule)",
    background: active
      ? "color-mix(in srgb, var(--color-info) 14%, transparent)"
      : "transparent",
    color: "var(--color-ink)",
  };
}

/** The same pill in warning dress. Its own function rather than a third
 *  boolean on `chipStyle` because it means something different: not "this is
 *  selected", but "read this — the run is not what you asked for". */
function warnChipStyle(): React.CSSProperties {
  return {
    ...chipStyle(false),
    border: "1px solid color-mix(in srgb, var(--color-warning) 65%, var(--color-rule))",
    background: "color-mix(in srgb, var(--color-warning) 14%, transparent)",
    color: "var(--color-warning)",
    fontWeight: 600,
  };
}

const eyebrowStyle: React.CSSProperties = {
  fontSize: "10px",
  fontWeight: 700,
  letterSpacing: "0.14em",
  textTransform: "uppercase",
  color: "var(--color-ink-muted)",
};

const cardStyle: React.CSSProperties = {
  border: "1px solid var(--color-rule)",
  background: "var(--color-bg-elevated)",
  borderRadius: "6px",
  padding: "10px 12px",
  display: "flex",
  flexDirection: "column",
  gap: "6px",
  minWidth: 0,
};

/** The state dot: pulsing info = running, success = done, warning = stalled
 *  or failed, muted outline = cached. */
function StateDot({ state, stalled }: { state: string; stalled: boolean }) {
  const color =
    state === "running"
      ? stalled
        ? "var(--color-warning)"
        : "var(--color-info)"
      : state === "done"
        ? "var(--color-success, #3a9d5c)"
        : state === "failed"
          ? "var(--color-danger, #d33)"
          : "transparent";
  return (
    <span
      aria-hidden
      className={state === "running" ? "rl-run-pulse" : undefined}
      style={{
        width: "8px",
        height: "8px",
        borderRadius: "2px",
        flexShrink: 0,
        background: color,
        border: state === "cached" ? "1px solid var(--color-rule)" : "none",
        boxShadow:
          state === "running"
            ? `0 0 8px color-mix(in srgb, ${
                stalled ? "var(--color-warning)" : "var(--color-info)"
              } 70%, transparent)`
            : "none",
      }}
    />
  );
}

function relTime(ts: number, now: number): string {
  const secs = Math.max(0, Math.round((now - ts) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** The run-state chip's wording — the same lifecycle the sidebar chip uses. */
function runStateChip(state: string | null): { text: string; live: boolean } {
  switch (state) {
    case "orchestrating":
      return { text: "launching", live: true };
    case "running":
      return { text: "running", live: true };
    case "in_code_review":
      return { text: "in code review", live: true };
    case "awaiting_review":
      // The overnight queue's parked state: the run ended committed to its
      // branch; the review waits for the human's morning. Not live.
      return { text: "awaiting review", live: false };
    case "landed":
      return { text: "landed", live: false };
    case "stalled":
      return { text: "stalled", live: false };
    default:
      return { text: state ?? "not started", live: false };
  }
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: "11px",
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: "0.04em",
        color: "var(--color-ink-muted)",
        margin: "14px 0 8px",
      }}
    >
      {children}
    </div>
  );
}

// --- agent tile -------------------------------------------------------------

function AgentCard({
  tile,
  now,
  conflictFiles,
  onOpen,
}: {
  tile: AgentTile;
  now: number;
  /** Files this agent shares with another agent (conflict highlight). */
  conflictFiles: string[];
  onOpen: (agentId: string) => void;
}) {
  const stalled = agentStalled(tile, now);
  const elapsed = tileElapsed(tile, now);
  const heuristic = tile.label != null && tile.labelSource !== "manifest";
  const meta: string[] = [];
  if (tile.phase) meta.push(tile.phase);
  if (tile.model) meta.push(tile.model.replace(/^claude-/, ""));
  if (tile.effort) meta.push(tile.effort);
  return (
    <button
      type="button"
      onClick={() => onOpen(tile.agentId)}
      className="font-sans"
      title={tile.promptPreview ?? tile.agentId}
      style={{
        ...cardStyle,
        textAlign: "left",
        cursor: "pointer",
        gap: "5px",
        borderColor: stalled
          ? "color-mix(in srgb, var(--color-warning) 60%, var(--color-rule))"
          : tile.state === "failed"
            ? "color-mix(in srgb, var(--color-danger, #d33) 55%, var(--color-rule))"
            : "var(--color-rule)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "7px", minWidth: 0 }}>
        <StateDot state={tile.state} stalled={stalled} />
        <span
          style={{
            fontSize: "12.5px",
            fontWeight: 600,
            color: "var(--color-ink)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            flex: 1,
          }}
        >
          {heuristic && (
            <span
              title="Label guessed from the workflow script — the completion manifest will confirm it"
              style={{ color: "var(--color-ink-muted)" }}
            >
              ~
            </span>
          )}
          {tileTitle(tile)}
        </span>
        {stalled && (
          <span
            title="No transcript activity for over 3 minutes — possibly waiting on a permission prompt"
            style={{ fontSize: "10px", color: "var(--color-warning)" }}
          >
            stalled?
          </span>
        )}
        {tile.state === "cached" && (
          <span style={{ fontSize: "10px", color: "var(--color-ink-muted)" }}>cached</span>
        )}
        {tile.degraded && (
          <span
            title="The seat's primary model was unavailable — this agent ran on its configured fallback"
            style={{ fontSize: "10px", color: "var(--color-warning)" }}
          >
            fallback model
          </span>
        )}
      </div>
      {meta.length > 0 && (
        <div
          style={{
            fontSize: "10.5px",
            color: "var(--color-ink-muted)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {meta.join(" · ")}
        </div>
      )}
      <div
        style={{
          display: "flex",
          gap: "10px",
          fontSize: "10.5px",
          color: "var(--color-ink-muted)",
          fontFamily: "var(--font-mono, ui-monospace, monospace)",
          flexWrap: "wrap",
        }}
      >
        {elapsed && <span>{elapsed}</span>}
        {tile.outputTokens > 0 && <span>{formatTokens(tile.outputTokens)} out</span>}
        {tile.toolCalls > 0 && (
          <span>
            {tile.toolCalls} tool{tile.toolCalls === 1 ? "" : "s"}
            {tile.state === "running" && tile.lastToolName ? ` · ${tile.lastToolName}` : ""}
          </span>
        )}
        {tile.filesChanged.length > 0 && (
          <span
            title={tile.filesChanged.join("\n")}
            style={
              conflictFiles.length > 0 ? { color: "var(--color-warning)" } : undefined
            }
          >
            {tile.filesChanged.length} file{tile.filesChanged.length === 1 ? "" : "s"}
            {conflictFiles.length > 0 ? " ⚠" : ""}
          </span>
        )}
      </div>
      {tile.resultPreview && tile.state !== "running" && (
        <div
          style={{
            fontSize: "11px",
            color: "var(--color-ink-muted)",
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}
        >
          {tile.resultPreview}
        </div>
      )}
    </button>
  );
}

// --- transcript drawer ------------------------------------------------------

function EventLine({ event }: { event: AgentTailEvent }) {
  if (event.kind === "text") {
    return (
      <div style={{ color: "var(--color-ink)", whiteSpace: "pre-wrap", margin: "6px 0" }}>
        {event.text}
      </div>
    );
  }
  if (event.kind === "toolUse") {
    return (
      <div style={{ color: "var(--color-info)" }}>
        ▸ {event.name}
        {event.summary && (
          <span style={{ color: "var(--color-ink-muted)" }}> — {event.summary}</span>
        )}
      </div>
    );
  }
  return (
    <div style={{ color: "var(--color-ink-muted)" }}>↳ {event.summary || "(empty result)"}</div>
  );
}

function AgentTranscriptDrawer({
  planSessionId,
  tile,
  onClose,
}: {
  planSessionId: string;
  tile: AgentTile;
  onClose: () => void;
}) {
  const { events, truncated, error } = useAgentTail(planSessionId, tile.agentId);
  const logRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);
  // Follow the stream while the user is at the bottom; a scroll-up pins the
  // view in place (reading history must not fight the tail).
  useEffect(() => {
    const el = logRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [events]);
  return (
    <div
      className="font-sans"
      style={{
        position: "absolute",
        top: 0,
        right: 0,
        bottom: 0,
        width: "min(480px, 60%)",
        display: "flex",
        flexDirection: "column",
        background: "var(--color-bg-elevated)",
        borderLeft: "1px solid var(--color-rule)",
        boxShadow: "-12px 0 24px color-mix(in srgb, var(--color-ink) 8%, transparent)",
        zIndex: 5,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          padding: "10px 12px",
          borderBottom: "1px solid var(--color-rule)",
        }}
      >
        <StateDot state={tile.state} stalled={false} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: "12.5px",
              fontWeight: 600,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {tileTitle(tile)}
          </div>
          <div
            style={{
              fontSize: "10px",
              color: "var(--color-ink-muted)",
              fontFamily: "var(--font-mono, ui-monospace, monospace)",
            }}
          >
            {tile.agentId}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          title="Close the transcript"
          style={{
            border: "none",
            background: "transparent",
            cursor: "pointer",
            color: "var(--color-ink-muted)",
            padding: "4px",
          }}
        >
          <X size={14} strokeWidth={2} />
        </button>
      </div>
      <div
        ref={logRef}
        onScroll={() => {
          const el = logRef.current;
          if (!el) return;
          pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "8px 12px",
          fontFamily: "var(--font-mono, ui-monospace, Menlo, monospace)",
          fontSize: "11px",
          lineHeight: 1.45,
          overflowWrap: "anywhere",
        }}
      >
        {truncated && (
          <div style={{ color: "var(--color-ink-muted)", fontStyle: "italic" }}>
            … earlier transcript elided (showing the tail)
          </div>
        )}
        {error && <div style={{ color: "var(--color-warning)" }}>{error}</div>}
        {events.length === 0 && !error && (
          <div style={{ color: "var(--color-ink-muted)" }}>Waiting for transcript…</div>
        )}
        {events.map((e, i) => (
          <EventLine key={i} event={e} />
        ))}
      </div>
    </div>
  );
}

// --- the monitor pane (pure: one snapshot + callbacks) ----------------------

function RunMonitorPane({
  snap,
  planTitle,
  now,
  onOpenAgent,
  onOpenRunReport,
  onStandDown,
}: {
  snap: RunSnapshot;
  planTitle: string | null;
  now: number;
  onOpenAgent: (agentId: string) => void;
  onOpenRunReport: (planSessionId: string) => void;
  /** Absent on a reconstructed history run — there is nothing left to stop. */
  onStandDown?: (planSessionId: string) => void;
}) {
  const chip = runStateChip(snap.runState);
  const t = snap.totals;
  const phases = phaseProgress(snap.phases, snap.agents);
  const conflicts = fileConflicts(snap.agents);
  const running = snap.agents
    .filter((a) => a.state === "running")
    .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
  const finished = snap.agents
    .filter((a) => a.state !== "running")
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  const conflictFilesOf = (tile: AgentTile) =>
    tile.filesChanged.filter((f) => conflicts.has(f));
  const conflictCount = runConflictCount(snap.agents);
  const runLive = isLiveRunState(snap.runState);
  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
      {/* Summary card row */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
          gap: "10px",
        }}
      >
        <div style={cardStyle}>
          <span style={eyebrowStyle}>Run</span>
          <div style={{ fontSize: "13px", fontWeight: 600 }}>
            {snap.workflowName ?? planTitle ?? snap.planSessionId.slice(0, 8)}
          </div>
          <div style={{ display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ ...chipStyle(chip.live), cursor: "default" }}>{chip.text}</span>
            {/* `sequential` is a degradation, not a setting — it used to
                render through the neutral style, so a run that never found
                its Workflow looked identical to one that did. */}
            <span
              title={
                isSequentialFallback(snap.mode) ? SEQUENTIAL_FALLBACK_NOTE : undefined
              }
              style={{
                ...(isSequentialFallback(snap.mode) ? warnChipStyle() : chipStyle(false)),
                cursor: "default",
              }}
            >
              {snap.mode === "pending"
                ? "waiting for launch"
                : isSequentialFallback(snap.mode)
                  ? "sequential fallback"
                  : snap.mode}
            </span>
            {/* Files two or more agents both changed. The set has always been
                computed; it only reached the individual tiles, so a collision
                was findable but not visible. The count belongs here, beside
                the action that answers it. */}
            {conflictCount > 0 && (
              <span
                title={`${[...conflicts.keys()].join(", ")} — changed by more than one agent`}
                style={{ ...warnChipStyle(), cursor: "default" }}
              >
                {conflictCount} file{conflictCount === 1 ? "" : "s"} in conflict
              </span>
            )}
            {conflictCount > 0 && runLive && onStandDown && (
              <button
                type="button"
                title="Mark the run abandoned and stop watching it"
                onClick={() => onStandDown(snap.planSessionId)}
                style={warnChipStyle()}
              >
                Stand down
              </button>
            )}
            <span style={{ fontSize: "11px", color: "var(--color-ink-muted)" }}>
              {runElapsed(snap, now)}
            </span>
          </div>
          {snap.workflowDescription && (
            <div style={{ fontSize: "11px", color: "var(--color-ink-muted)" }}>
              {snap.workflowDescription}
            </div>
          )}
        </div>
        <div style={cardStyle}>
          <span style={eyebrowStyle}>Agents</span>
          <div style={{ fontSize: "13px", fontWeight: 600 }}>
            {t.running} running · {t.done} done
            {t.failed > 0 ? ` · ${t.failed} failed` : ""}
          </div>
          <div style={{ fontSize: "11px", color: "var(--color-ink-muted)" }}>
            {snap.manifest?.agentCount != null
              ? `${snap.manifest.agentCount} total`
              : t.plannedAgents != null
                ? `~${t.plannedAgents} planned (script call sites)`
                : "counting from the run journal"}
          </div>
        </div>
        <div style={cardStyle}>
          <span style={eyebrowStyle}>Totals</span>
          <div
            style={{
              fontSize: "12px",
              fontFamily: "var(--font-mono, ui-monospace, monospace)",
            }}
          >
            {snap.manifest?.totalTokens != null
              ? `${formatTokens(snap.manifest.totalTokens)} tokens`
              : `${formatTokens(t.inputTokens + t.outputTokens)} tokens (${formatTokens(
                  t.outputTokens,
                )} out)`}
            {" · "}
            {snap.manifest?.totalToolCalls ?? t.toolCalls} tool calls
          </div>
          <div style={{ fontSize: "11px", color: "var(--color-ink-muted)" }}>
            {t.filesChanged.length} file{t.filesChanged.length === 1 ? "" : "s"} changed
            {conflicts.size > 0 ? ` · ${conflicts.size} claimed by 2+ agents ⚠` : ""}
          </div>
        </div>
        {phases.length > 0 && (
          <div style={cardStyle}>
            <span style={eyebrowStyle}>Phases</span>
            <div style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
              {phases.map((p) => (
                <div
                  key={p.title}
                  title={p.detail ?? undefined}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "6px",
                    fontSize: "11px",
                  }}
                >
                  <span
                    aria-hidden
                    style={{
                      width: "7px",
                      height: "7px",
                      borderRadius: "2px",
                      flexShrink: 0,
                      background:
                        p.failed > 0
                          ? "var(--color-danger, #d33)"
                          : p.running > 0
                            ? "var(--color-info)"
                            : p.total > 0 && p.done === p.total
                              ? "var(--color-success, #3a9d5c)"
                              : "transparent",
                      border:
                        p.total === 0 || (p.done < p.total && p.running === 0 && p.failed === 0)
                          ? "1px solid var(--color-rule)"
                          : "none",
                    }}
                  />
                  <span
                    style={{
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      flex: 1,
                    }}
                  >
                    {p.title}
                  </span>
                  {p.total > 0 && (
                    <span style={{ color: "var(--color-ink-muted)" }}>
                      {p.done}/{p.total}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Honest degradation: sequential fallback, missing dirs, skip notes,
          agents that kept going on their seats' fallback models. */}
      {(snap.notes.length > 0 || snap.dirsMissing || (t.degraded ?? 0) > 0) && (
        <div style={{ marginTop: "8px", display: "flex", flexDirection: "column", gap: "2px" }}>
          {snap.notes.map((n) => (
            <div
              key={n}
              style={{
                fontSize: "10.5px",
                color: snap.dirsMissing ? "var(--color-warning)" : "var(--color-ink-muted)",
              }}
            >
              {n}
            </div>
          ))}
          {(t.degraded ?? 0) > 0 && (
            <div style={{ fontSize: "10.5px", color: "var(--color-warning)" }}>
              {t.degraded} agent{t.degraded === 1 ? "" : "s"} ran on fallback models
            </div>
          )}
        </div>
      )}

      {/* Exit-report handoff — links (never duplicates) RunReport. */}
      {snap.reportFiled && (
        <div
          style={{
            marginTop: "10px",
            display: "flex",
            alignItems: "center",
            gap: "10px",
            padding: "8px 12px",
            borderRadius: "6px",
            border: "1px solid color-mix(in srgb, var(--color-info) 40%, var(--color-rule))",
            background: "color-mix(in srgb, var(--color-info) 8%, transparent)",
            fontSize: "12px",
          }}
        >
          <span style={{ flex: 1 }}>The orchestrator filed its exit report.</span>
          <button
            type="button"
            onClick={() => onOpenRunReport(snap.planSessionId)}
            style={{ ...chipStyle(true), fontSize: "11px" }}
          >
            Open run report →
          </button>
        </div>
      )}

      {snap.mode === "pending" && snap.agents.length === 0 ? (
        <div
          style={{
            marginTop: "24px",
            textAlign: "center",
            fontSize: "12px",
            color: "var(--color-ink-muted)",
          }}
        >
          Waiting for the Workflow to launch — the orchestrator is reading the plan…
        </div>
      ) : (
        <>
          {running.length > 0 && (
            <>
              <SectionTitle>Running</SectionTitle>
              <div className="rl-server-grid">
                {running.map((a) => (
                  <AgentCard
                    key={a.agentId}
                    tile={a}
                    now={now}
                    conflictFiles={conflictFilesOf(a)}
                    onOpen={onOpenAgent}
                  />
                ))}
              </div>
            </>
          )}
          {finished.length > 0 && (
            <>
              <SectionTitle>Finished</SectionTitle>
              <div className="rl-server-grid">
                {finished.map((a) => (
                  <AgentCard
                    key={a.agentId}
                    tile={a}
                    now={now}
                    conflictFiles={conflictFilesOf(a)}
                    onOpen={onOpenAgent}
                  />
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

// --- history ----------------------------------------------------------------

function HistoryRow({
  run,
  summary,
  selected,
  now,
  onSelect,
}: {
  run: OrchestrationRow;
  summary: SessionSummary | undefined;
  selected: boolean;
  now: number;
  onSelect: (sid: string) => void;
}) {
  const live = isLiveRunState(run.runState);
  return (
    <button
      type="button"
      onClick={() => onSelect(run.planSessionId)}
      className="font-sans"
      style={{
        display: "flex",
        alignItems: "center",
        gap: "10px",
        width: "100%",
        textAlign: "left",
        padding: "8px 10px",
        borderRadius: "6px",
        cursor: "pointer",
        border: selected
          ? "1px solid color-mix(in srgb, var(--color-info) 55%, var(--color-rule))"
          : "1px solid var(--color-rule)",
        background: selected
          ? "color-mix(in srgb, var(--color-info) 8%, transparent)"
          : "var(--color-bg-elevated)",
      }}
    >
      <StateDot
        state={
          live
            ? "running"
            : run.runState === "stalled"
              ? "failed"
              : run.runState === "abandoned" || run.runState === "awaiting_review"
                ? "cached"
                : "done"
        }
        stalled={false}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: "12.5px",
            fontWeight: 600,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {summary?.planTitle ?? run.planSessionId}
        </div>
        <div style={{ fontSize: "10.5px", color: "var(--color-ink-muted)" }}>
          {summary?.projectName ?? run.cwd ?? "unknown project"}
          {" · "}
          {relTime(run.startedAt, now)}
        </div>
      </div>
      {run.mode && (
        <span
          title={isSequentialFallback(run.mode) ? SEQUENTIAL_FALLBACK_NOTE : undefined}
          style={{
            ...(isSequentialFallback(run.mode) ? warnChipStyle() : chipStyle(false)),
            cursor: "default",
          }}
        >
          {isSequentialFallback(run.mode) ? "sequential fallback" : run.mode}
        </span>
      )}
      <span style={{ ...chipStyle(live), cursor: "default" }}>{runOutcomeLabel(run)}</span>
    </button>
  );
}

// --- the work graph ---------------------------------------------------------

/** One work-graph row: id, title, kind, priority, status, origin, blockers.
 *  Read-only this wave — the graph is consumed by agents over the routes and
 *  inspected here; no claim/close buttons. */
function WorkItemRow({
  item,
  statusWord,
  blockedBy,
}: {
  item: WorkItem;
  statusWord: string;
  blockedBy: number;
}) {
  const statusColor =
    statusWord === "ready"
      ? "var(--color-success, #3a9d5c)"
      : statusWord === "blocked"
        ? "var(--color-warning)"
        : statusWord === "claimed"
          ? "var(--color-info)"
          : "var(--color-ink-muted)";
  return (
    <div
      className="font-sans"
      title={item.body ?? undefined}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "10px",
        width: "100%",
        padding: "7px 10px",
        borderRadius: "6px",
        border: "1px solid var(--color-rule)",
        background: "var(--color-bg-elevated)",
      }}
    >
      <span
        style={{
          fontSize: "10.5px",
          color: "var(--color-ink-muted)",
          fontFamily: "var(--font-mono, ui-monospace, monospace)",
          flexShrink: 0,
        }}
      >
        {item.id}
      </span>
      <span
        style={{
          fontSize: "12.5px",
          fontWeight: 600,
          flex: 1,
          minWidth: 0,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {item.title}
      </span>
      <span style={{ fontSize: "10.5px", color: "var(--color-ink-muted)" }}>
        {item.kind}
      </span>
      <span
        style={{
          fontSize: "10.5px",
          color: "var(--color-ink-muted)",
          fontFamily: "var(--font-mono, ui-monospace, monospace)",
        }}
      >
        P{item.priority}
      </span>
      <span style={{ fontSize: "10.5px", color: "var(--color-ink-muted)" }}>
        {workOriginLabel(item)}
      </span>
      {blockedBy > 0 && (
        <span style={{ fontSize: "10.5px", color: "var(--color-warning)" }}>
          blocked by {blockedBy}
        </span>
      )}
      <span
        style={{
          ...chipStyle(statusWord === "ready"),
          cursor: "default",
          color: statusColor,
        }}
      >
        {statusWord}
        {statusWord === "claimed" && item.assignee ? ` · ${item.assignee}` : ""}
      </span>
    </div>
  );
}

/** The Work tab: the cross-project graph, ready frontier first, grouped by
 *  the project facet ("(no project)" bucket last on ties). */
function WorkGraphPane({ graph }: { graph: WorkGraph }) {
  const readyIds = useMemo(() => new Set(graph.readyIds), [graph.readyIds]);
  const blockedBy = useMemo(
    () => workBlockedByCounts(graph.items, graph.edges),
    [graph.items, graph.edges],
  );
  const groups = useMemo(
    () => groupWorkByProject(graph.items, readyIds),
    [graph.items, readyIds],
  );
  if (graph.items.length === 0) {
    return (
      <EmptyState
        title="No open work"
        body="Filed work items appear here — the ready frontier is what the next run fans out over."
      />
    );
  }
  return (
    <>
      {groups.map((g) => (
        <React.Fragment key={g.project ?? "(no project)"}>
          <SectionTitle>
            {g.project ?? "(no project)"}
            {g.readyCount > 0 ? ` · ${g.readyCount} ready` : ""}
          </SectionTitle>
          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            {g.items.map((item) => (
              <WorkItemRow
                key={item.id}
                item={item}
                statusWord={workStatusLabel(
                  item,
                  readyIds,
                  blockedBy.get(item.id) ?? 0,
                )}
                blockedBy={blockedBy.get(item.id) ?? 0}
              />
            ))}
          </div>
        </React.Fragment>
      ))}
    </>
  );
}

// --- the surface ------------------------------------------------------------

type RunsTab = "live" | "history" | "work";
const RUNS_TABS: readonly RunsTab[] = ["live", "history", "work"];

export interface OrchestrationSurfaceProps {
  /** Whether this surface is the one on screen — gates every poll. */
  active: boolean;
  summaries: SessionSummary[];
  /** The sidebar's selected plan session — preferred when it has a live run. */
  activePlanSessionId: string | null;
  /** Open the RunReport container (claims vs ground truth) on the review
   *  surface — this surface links it, never duplicates it. */
  onOpenRunReport: (planSessionId: string) => void;
  /** Recovery actions for the "handoff never completed" card (a session whose
   *  chip is live with no orchestrations row) — all owned by App. */
  onRetryLaunch: (planSessionId: string) => void;
  onResetRun: (planSessionId: string) => void;
  onUnapprove: (planSessionId: string) => void;
  onStandDown: (planSessionId: string) => void;
  /** "Go to Runs: Work" from the command palette. Nonce'd: a controlled prop
   *  would drag this surface back to that tab on every render. */
  tabRequest?: TabRequest | null;
  /** A reviewed Orchestrate plan opens its durable draft directly. */
  nativeRunId?: string | null;
  onOpenPlanBlock?: (sessionId: string, blockId: string) => void;
  onReviewSession?: (reviewId: string) => void;
}

/** The failure state this surface exists to make visible: `run_state` says a
 *  run is live, but no ingest claim ever anchored an `orchestrations` row —
 *  the orchestrator was never actually delivered. Rendered per phantom
 *  session in place of the empty Live tab the bug used to produce. */
function PhantomRunCard({
  summary,
  onRetryLaunch,
  onResetRun,
  onUnapprove,
  onStandDown,
}: {
  summary: SessionSummary;
  onRetryLaunch: (sid: string) => void;
  onResetRun: (sid: string) => void;
  onUnapprove: (sid: string) => void;
  onStandDown: (sid: string) => void;
}) {
  const sid = summary.sessionId;
  const actions: { label: string; hint: string; onClick: () => void }[] = [
    {
      label: "Retry launch",
      hint: "Reset the run and deliver the orchestrator again (the plan stays approved)",
      onClick: () => onRetryLaunch(sid),
    },
    {
      label: "Reset run",
      hint: "Clear the run chip back to nothing — approval untouched",
      onClick: () => onResetRun(sid),
    },
    {
      label: "Un-approve",
      hint: "Rescind the approval (ledger supersession) and return the plan to review",
      onClick: () => onUnapprove(sid),
    },
    {
      label: "Stand down",
      hint: "Mark the run abandoned and stop watching it",
      onClick: () => onStandDown(sid),
    },
  ];
  return (
    <div
      style={{
        ...cardStyle,
        borderColor: "color-mix(in srgb, var(--color-warning) 55%, var(--color-rule))",
        marginBottom: "10px",
      }}
    >
      <span style={{ ...eyebrowStyle, color: "var(--color-warning)" }}>
        Handoff never completed
      </span>
      <div style={{ fontSize: "13px", fontWeight: 600 }}>
        {summary.planTitle ?? sid.slice(0, 8)}
      </div>
      <div style={{ fontSize: "11.5px", color: "var(--color-ink-muted)" }}>
        The chip reads “{summary.runState?.replace(/_/g, " ")}”, but no
        orchestrator ever claimed this run — the launch was likely never
        delivered to its terminal.
      </div>
      <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginTop: "2px" }}>
        {actions.map((a) => (
          <button
            key={a.label}
            type="button"
            title={a.hint}
            onClick={a.onClick}
            style={chipStyle(a.label === "Retry launch")}
          >
            {a.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function OrchestrationSurface({
  active,
  summaries,
  activePlanSessionId,
  onOpenRunReport,
  onRetryLaunch,
  onResetRun,
  onUnapprove,
  onStandDown,
  tabRequest = null,
  nativeRunId = null,
  onOpenPlanBlock,
  onReviewSession,
}: OrchestrationSurfaceProps) {
  const { runs } = useOrchestrationRuns(active);
  const { runs: nativeRuns, error: nativeError } = useRunGraphList(active);
  const [pickedNative, setPickedNative] = useState<string | null>(null);
  const [historyNative, setHistoryNative] = useState<string | null>(null);
  const nativeLive = nativeRuns.filter((run) => !["done", "abandoned"].includes(run.status));
  const selectedNative = pickedNative ?? nativeRunId
    ?? nativeLive.find((run) => run.planSessionId === activePlanSessionId)?.runId
    ?? nativeLive[0]?.runId ?? null;
  const ordered = useMemo(() => orderRuns(runs), [runs]);
  const liveRuns = useMemo(
    () => ordered.filter((r) => isLiveRunState(r.runState)),
    [ordered],
  );
  // Chip says live, but no ingest claim ever anchored a row: the handoff
  // never completed. These get the recovery card instead of vanishing into
  // an empty Live tab.
  const phantomRuns = useMemo(
    () =>
      summaries.filter(
        (s) =>
          isLiveRunState(s.runState) &&
          !runs.some((r) => r.planSessionId === s.sessionId) &&
          !nativeRuns.some((r) => r.planSessionId === s.sessionId),
      ),
    [summaries, runs, nativeRuns],
  );
  const [tab, setTab] = useState<RunsTab>("live");
  useEffect(() => { if (nativeRunId) { setPickedNative(nativeRunId); setTab("live"); } }, [nativeRunId]);
  const tabNonce = tabRequest?.nonce;
  useEffect(() => {
    if (!tabRequest) return;
    if (RUNS_TABS.includes(tabRequest.tab as RunsTab))
      setTab(tabRequest.tab as RunsTab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabNonce]);
  const [pickedLive, setPickedLive] = useState<string | null>(null);
  const [historySid, setHistorySid] = useState<string | null>(null);
  const [drawerAgent, setDrawerAgent] = useState<string | null>(null);

  // The cross-project work graph, one read-only rollup. Refreshed on a slow
  // poll while the surface is visible (the tab badge + Work tab both ride it)
  // and immediately on a tab switch.
  const [workGraph, setWorkGraph] = useState<WorkGraph | null>(null);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const load = async () => {
      try {
        const g = await invoke<WorkGraph>("get_work_graph");
        if (!cancelled) setWorkGraph(g);
      } catch {
        /* read-only surface: keep the last snapshot */
      }
    };
    void load();
    const t = window.setInterval(() => void load(), 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [active, tab]);
  const workReady = workGraph?.readyIds.length ?? 0;

  // The Live tab's run: an explicit pick (while it stays live), else the
  // sidebar's plan (when its run is live), else the newest live run.
  const liveSid =
    (pickedLive && liveRuns.some((r) => r.planSessionId === pickedLive)
      ? pickedLive
      : null) ??
    (activePlanSessionId &&
    liveRuns.some((r) => r.planSessionId === activePlanSessionId)
      ? activePlanSessionId
      : null) ??
    liveRuns[0]?.planSessionId ??
    null;
  const monitorSid =
    tab === "live" ? (selectedNative ? null : liveSid) : tab === "history" ? (historyNative ? null : historySid) : null;
  const snapshot = useOrchestration(monitorSid, active);

  // One clock for elapsed/stall rendering — a tick per second while visible.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [active]);

  // The drawer belongs to one run; a run/tab switch closes it.
  useEffect(() => {
    setDrawerAgent(null);
  }, [monitorSid]);

  const summaryFor = (sid: string | null) =>
    sid ? summaries.find((s) => s.sessionId === sid) : undefined;
  const liveAgents =
    tab === "live" && snapshot && isLiveRunState(snapshot.runState)
      ? snapshot.totals.running
      : null;
  const sentence = runStatusSentence(runs, liveAgents);
  const drawerTile =
    drawerAgent && snapshot
      ? snapshot.agents.find((a) => a.agentId === drawerAgent) ?? null
      : null;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        background: "var(--color-bg-elevated)",
      }}
    >
      {/* Hero header — the Agent Seats corner glow + gradient wash. */}
      <header
        style={{
          position: "relative",
          flexShrink: 0,
          padding: "14px 20px 12px",
          background:
            "radial-gradient(120% 140% at 0% 0%, color-mix(in srgb, var(--color-info) 12%, transparent), transparent 60%), linear-gradient(180deg, var(--color-bg-elevated), var(--color-paper))",
        }}
      >
        <div
          className="font-sans flex items-center gap-2"
          style={{
            fontSize: "11px",
            fontWeight: 700,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            color: "var(--color-ink-muted)",
          }}
        >
          <span
            aria-hidden
            style={{
              width: "9px",
              height: "9px",
              borderRadius: "2px",
              background: "var(--color-info)",
              boxShadow: "0 0 10px color-mix(in srgb, var(--color-info) 70%, transparent)",
            }}
          />
          Runs
        </div>
        <div
          className="font-sans"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            fontSize: "12px",
            color: "var(--color-ink-muted)",
            marginTop: "8px",
          }}
        >
          <span style={{ flex: 1 }}>{nativeLive.length ? `${nativeLive.length} native run${nativeLive.length === 1 ? "" : "s"} · review, run and steer the graph` : sentence}</span>
          <div style={{ display: "flex", gap: 4 }}>
            {RUNS_TABS.map((t) => (
              <button
                key={t}
                type="button"
                className="font-sans"
                onClick={() => setTab(t)}
                style={{
                  ...chipStyle(tab === t),
                  fontSize: "11px",
                  textTransform: "capitalize",
                }}
              >
                {t}
                {t === "live" && liveRuns.length + nativeLive.length > 0 && (
                  <span
                    style={{
                      marginLeft: 5,
                      padding: "0 5px",
                      borderRadius: 999,
                      fontSize: "10px",
                      color: "#fff",
                      background: "var(--color-info)",
                    }}
                  >
                    {liveRuns.length + nativeLive.length}
                  </span>
                )}
                {t === "work" && workReady > 0 && (
                  <span
                    style={{
                      marginLeft: 5,
                      padding: "0 5px",
                      borderRadius: 999,
                      fontSize: "10px",
                      color: "#fff",
                      background: "var(--color-info)",
                    }}
                  >
                    {workReady}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      </header>
      {/* Hairline accent seam under the hero. */}
      <div
        aria-hidden
        style={{
          flexShrink: 0,
          height: "2px",
          opacity: 0.65,
          background:
            "linear-gradient(90deg, var(--color-info), color-mix(in srgb, var(--color-info) 20%, transparent))",
        }}
      />
      <div
        className="font-sans"
        style={{
          position: "relative",
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          padding: "14px 20px 20px",
        }}
      >
        {tab === "live" ? (
          selectedNative ? <>
            {nativeLive.length > 1 && <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>{nativeLive.map((run) => <button key={run.runId} style={chipStyle(run.runId === selectedNative)} onClick={() => setPickedNative(run.runId)}>{summaryFor(run.planSessionId ?? null)?.planTitle ?? run.projectPath.split("/").pop()} · {run.status}</button>)}</div>}
            <RunGraphPane key={selectedNative} runId={selectedNative} active={active} onOpenPlanBlock={onOpenPlanBlock} onReviewSession={onReviewSession} />
          </> : <>
          {nativeError && <p style={{ color: "var(--color-warning)", fontSize: 12 }}>Native run list: {nativeError}</p>}
          {phantomRuns.map((s) => (
            <PhantomRunCard
              key={s.sessionId}
              summary={s}
              onRetryLaunch={onRetryLaunch}
              onResetRun={onResetRun}
              onUnapprove={onUnapprove}
              onStandDown={onStandDown}
            />
          ))}
          {runs.length === 0 ? (
            phantomRuns.length === 0 && (
              <EmptyState
                title="No orchestrated runs yet"
                body="Approve a plan with Orchestrate and its agents will appear here, live."
              />
            )
          ) : liveRuns.length === 0 ? (
            phantomRuns.length === 0 && (
              <EmptyState
                title="No run is live right now"
                body="Finished runs are in History — open one to see its full reconstruction."
              />
            )
          ) : (
            <>
              {liveRuns.length > 1 && (
                <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginBottom: "12px" }}>
                  {liveRuns.map((r) => (
                    <button
                      key={r.planSessionId}
                      type="button"
                      onClick={() => setPickedLive(r.planSessionId)}
                      style={chipStyle(r.planSessionId === liveSid)}
                    >
                      {summaryFor(r.planSessionId)?.planTitle ?? r.planSessionId.slice(0, 8)}
                    </button>
                  ))}
                </div>
              )}
              {snapshot ? (
                <RunMonitorPane
                  snap={snapshot}
                  planTitle={summaryFor(liveSid)?.planTitle ?? null}
                  now={now}
                  onOpenAgent={setDrawerAgent}
                  onOpenRunReport={onOpenRunReport}
                  onStandDown={onStandDown}
                />
              ) : (
                <div style={{ fontSize: "12px", color: "var(--color-ink-muted)" }}>
                  Reading the run…
                </div>
              )}
            </>
          )}
          </>
        ) : tab === "history" ? (
          <>
            {nativeRuns.length > 0 && <>
              <SectionTitle>Native runs · measured results</SectionTitle>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>{nativeRuns.map((run) => <button key={run.runId} style={chipStyle(historyNative === run.runId)} onClick={() => { setHistoryNative((current) => current === run.runId ? null : run.runId); setHistorySid(null); }}>{summaryFor(run.planSessionId ?? null)?.planTitle ?? run.projectPath.split("/").pop()} · {run.status}</button>)}</div>
              {historyNative && <RunGraphPane key={historyNative} runId={historyNative} active={active} onOpenPlanBlock={onOpenPlanBlock} onReviewSession={onReviewSession} />}
            </>}
            {ordered.length === 0 ? (nativeRuns.length === 0 &&
              <EmptyState
                title="No orchestrated runs yet"
                body="Every Orchestrate launch is recorded here, live or finished."
              />
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                {ordered.map((r) => (
                  <HistoryRow
                    key={r.planSessionId}
                    run={r}
                    summary={summaryFor(r.planSessionId)}
                    selected={r.planSessionId === historySid}
                    now={now}
                    onSelect={(sid) => { setHistoryNative(null); setHistorySid((cur) => (cur === sid ? null : sid)); }}
                  />
                ))}
              </div>
            )}
            {historySid && snapshot && (
              <div style={{ marginTop: "16px" }}>
                <SectionTitle>
                  Reconstructed from disk
                  {snapshot.dirsMissing ? " (transcripts partially gone)" : ""}
                </SectionTitle>
                <RunMonitorPane
                  snap={snapshot}
                  planTitle={summaryFor(historySid)?.planTitle ?? null}
                  now={now}
                  onOpenAgent={setDrawerAgent}
                  onOpenRunReport={onOpenRunReport}
                />
              </div>
            )}
          </>
        ) : workGraph == null ? (
          <div style={{ fontSize: "12px", color: "var(--color-ink-muted)" }}>
            Reading the work graph…
          </div>
        ) : (
          <WorkGraphPane graph={workGraph} />
        )}
        {drawerTile && monitorSid && (
          <AgentTranscriptDrawer
            planSessionId={monitorSid}
            tile={drawerTile}
            onClose={() => setDrawerAgent(null)}
          />
        )}
      </div>
    </div>
  );
}
