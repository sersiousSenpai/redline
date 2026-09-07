// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

// Pure helpers for the Orchestration Monitor (the Runs surface): status
// sentences, run ordering, token/elapsed formatting, the drawer's tail-cap
// reducer, and the derivable enrichments (stall highlight, files-changed
// conflict detection, per-phase completion). Pure so every rendering rule
// the tiles rely on is unit-testable without mounting the surface.

import type {
  AgentTailEvent,
  AgentTile,
  OrchestrationRow,
  RunPhase,
  RunSnapshot,
  WorkEdge,
  WorkItem,
} from "../types";

/** FE mirror of `runwatch::is_live_run_state` — which run_state values mean
 *  a run is still in flight (watcher alive, Live tab shows it). */
export function isLiveRunState(state: string | null | undefined): boolean {
  return (
    state === "orchestrating" || state === "running" || state === "in_code_review"
  );
}

/** Where a run must be launched — the project directory, or `null` meaning
 *  REFUSE.
 *
 *  `relaunchOrchestrator` used to recover the path from `summaries` alone and
 *  hand `summary?.projectPath || null` straight to the launch builder. A miss
 *  yields `null`, `buildOrchestrateLaunchCommand` then emits no `cd`, and the
 *  PTY spawns in `$HOME`. The orchestrator runs `--permission-mode
 *  acceptEdits`, so the severity is not "it fails" — it is "it succeeds,
 *  write-capable, in the wrong tree". The first launch reads the path off the
 *  loaded session; the recovery path resolves the same way and then falls
 *  back, and a `null` here is an instruction to refuse rather than a default
 *  directory. */
export function resolveRunProject(
  sessionId: string,
  loaded: { sessionId: string; projectPath?: string | null } | null | undefined,
  summaries: readonly { sessionId: string; projectPath?: string | null }[],
): string | null {
  const clean = (p: string | null | undefined): string | null => {
    const t = (p ?? "").trim();
    return t.length > 0 ? t : null;
  };
  if (loaded && loaded.sessionId === sessionId) {
    const fromLoaded = clean(loaded.projectPath);
    if (fromLoaded) return fromLoaded;
  }
  return clean(summaries.find((x) => x.sessionId === sessionId)?.projectPath);
}

/** A run whose `mode` is `sequential` did NOT execute the way it was asked
 *  to. `runwatch::scan_once` writes that value when it finds no Workflow run
 *  and the orchestrator fell back to working through the plan one subtask at
 *  a time — it even records the note "no Workflow run found — sequential
 *  fallback". Ground truth already exists; the defect was that every surface
 *  rendered it in the neutral chip style, so a degraded run looked exactly
 *  like the multi-agent run the user launched. */
export function isSequentialFallback(mode: string | null | undefined): boolean {
  return mode === "sequential";
}

/** The one sentence every surface uses for it, so the run card, the history
 *  row and the sidebar chip can't drift into three explanations. */
export const SEQUENTIAL_FALLBACK_NOTE =
  "Sequential fallback — no Workflow run was found, so this plan ran one " +
  "subtask at a time instead of in parallel agents.";

/** How many files two or more agents in this run both claim to have changed.
 *  `fileConflicts` has always computed the set; it only ever reached the
 *  individual agent tiles, so noticing a collision meant reading every tile.
 *  The count is what belongs at run level, next to the action that answers
 *  it. */
export function runConflictCount(agents: AgentTile[]): number {
  return fileConflicts(agents).size;
}

/** 887191 → "887k", 1234567 → "1.2M", 431 → "431". */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${m >= 10 ? Math.round(m) : Math.round(m * 10) / 10}M`;
  }
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

/** 2900819 → "48m 20s"; sub-minute → "42s"; multi-hour → "2h 5m". */
export function formatElapsed(ms: number): string {
  const secs = Math.max(0, Math.floor(ms / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m`;
}

/** Live runs first (newest launch first), then the rest, newest first — the
 *  History list's order and the Live tab's run-picker order. */
export function orderRuns(rows: OrchestrationRow[]): OrchestrationRow[] {
  const rank = (r: OrchestrationRow) => (isLiveRunState(r.runState) ? 0 : 1);
  return [...rows].sort(
    (a, b) => rank(a) - rank(b) || b.startedAt - a.startedAt,
  );
}

/** The hero's one-line status sentence. */
export function runStatusSentence(
  rows: OrchestrationRow[],
  liveAgents: number | null,
): string {
  if (rows.length === 0) return "No orchestrated runs yet";
  const live = rows.filter((r) => isLiveRunState(r.runState)).length;
  if (live === 0) {
    return `No live runs · ${rows.length} in history`;
  }
  const runPart = live === 1 ? "1 run live" : `${live} runs live`;
  const agentPart =
    liveAgents && liveAgents > 0
      ? ` · ${liveAgents} agent${liveAgents === 1 ? "" : "s"} working`
      : "";
  return runPart + agentPart;
}

/** The size of one tail event for the cap budget. */
function eventChars(e: AgentTailEvent): number {
  switch (e.kind) {
    case "text":
      return e.text.length;
    case "toolUse":
      return e.name.length + e.summary.length;
    case "toolResult":
      return e.summary.length;
  }
}

/** Keep the NEWEST events within a char budget (the useAiReview 60k-tail
 *  convention) — the drawer is a tail, so old lines fall off the top. */
export function capTailEvents(
  events: AgentTailEvent[],
  budget: number,
): AgentTailEvent[] {
  let total = 0;
  let start = events.length;
  while (start > 0 && total + eventChars(events[start - 1]) <= budget) {
    total += eventChars(events[start - 1]);
    start -= 1;
  }
  return start === 0 ? events : events.slice(start);
}

/** Stall highlight: a running agent silent for over 3 minutes gets a warning
 *  dot — it may be stuck on a permission prompt or a long build. */
export const STALL_AFTER_MS = 3 * 60 * 1000;

export function agentStalled(tile: AgentTile, now: number): boolean {
  return (
    tile.state === "running" &&
    tile.lastActivityAt != null &&
    now - tile.lastActivityAt > STALL_AFTER_MS
  );
}

/** Files two or more agents both claim to have changed — the one mid-run
 *  signal that parallel work is about to collide. */
export function fileConflicts(agents: AgentTile[]): Map<string, string[]> {
  const byFile = new Map<string, string[]>();
  for (const a of agents) {
    for (const f of a.filesChanged) {
      const list = byFile.get(f) ?? [];
      if (!list.includes(a.agentId)) list.push(a.agentId);
      byFile.set(f, list);
    }
  }
  const conflicts = new Map<string, string[]>();
  for (const [f, ids] of byFile) {
    if (ids.length >= 2) conflicts.set(f, ids);
  }
  return conflicts;
}

export interface PhaseProgress {
  title: string;
  detail: string | null;
  total: number;
  done: number;
  running: number;
  failed: number;
}

/** Per-phase rollup for the phase strip. Tiles attach to phases by title
 *  (heuristic until the manifest); tiles with no phase are simply not
 *  counted — the strip shows the plan, not a census. */
export function phaseProgress(
  phases: RunPhase[],
  agents: AgentTile[],
): PhaseProgress[] {
  return phases.map((p) => {
    const mine = agents.filter((a) => a.phase === p.title);
    return {
      title: p.title,
      detail: p.detail,
      total: mine.length,
      done: mine.filter((a) => a.state === "done" || a.state === "cached").length,
      running: mine.filter((a) => a.state === "running").length,
      failed: mine.filter((a) => a.state === "failed").length,
    };
  });
}

/** A tile's display title: label, else the prompt preview, else the id. */
export function tileTitle(tile: AgentTile): string {
  if (tile.label) return tile.label;
  if (tile.promptPreview) return tile.promptPreview;
  return tile.agentId.slice(0, 8);
}

/** Elapsed for a tile: running counts up from start; finished shows its
 *  recorded duration. */
export function tileElapsed(tile: AgentTile, now: number): string | null {
  if (tile.state === "running" && tile.startedAt != null) {
    return formatElapsed(now - tile.startedAt);
  }
  if (tile.durationMs != null) return formatElapsed(tile.durationMs);
  return null;
}

/** Elapsed for the run header: the manifest's duration once it exists,
 *  otherwise time since launch (live) — never a frozen mid-run guess. */
export function runElapsed(snap: RunSnapshot, now: number): string {
  if (snap.manifest?.durationMs != null) {
    return formatElapsed(snap.manifest.durationMs);
  }
  return formatElapsed(now - snap.startedAt);
}

/** The human word for a run row's outcome column. `awaiting_review` is the
 *  overnight queue's parked state — deliberately NOT live (no watcher), so it
 *  labels here rather than in the live branch. */
export function runOutcomeLabel(row: OrchestrationRow): string {
  if (isLiveRunState(row.runState)) return row.runState as string;
  if (row.runState === "awaiting_review") return "awaiting review";
  return row.runState ?? "not started";
}

// --- the Work tab (pure display logic over the work-graph rollup) -----------

/** Unclosed blockers per item id: `blocks` edges pointing AT an item whose
 *  blocker row is present in `items`. The rollup already excludes closed
 *  items, so presence == "exists and is not closed" — the FE mirror of the
 *  ready CTE's rule 4 (a dangling `blocks` edge never blocks). */
export function workBlockedByCounts(
  items: WorkItem[],
  edges: WorkEdge[],
): Map<string, number> {
  const present = new Set(items.map((i) => i.id));
  const counts = new Map<string, number>();
  for (const e of edges) {
    if (e.type !== "blocks" || !present.has(e.fromId)) continue;
    counts.set(e.toId, (counts.get(e.toId) ?? 0) + 1);
  }
  return counts;
}

/** Ordering band within a project group: the ready frontier first, then
 *  open-but-blocked/deferred, then claimed, then held. */
export function workItemRank(item: WorkItem, readyIds: Set<string>): number {
  if (item.status === "open") return readyIds.has(item.id) ? 0 : 1;
  if (item.status === "claimed") return 2;
  return 3; // held (closed never reaches the tab)
}

/** The row's status word. An open item that is neither ready nor blocked is
 *  deferred (its own defer time or a deferred ancestor — the CTE's other
 *  exclusion), so the label set is exactly the tab's vocabulary. */
export function workStatusLabel(
  item: WorkItem,
  readyIds: Set<string>,
  blockedBy: number,
): string {
  if (item.status !== "open") return item.status;
  if (readyIds.has(item.id)) return "ready";
  if (blockedBy > 0) return "blocked";
  return "deferred";
}

/** The provenance breadcrumb as a short label: "drafter · 1a2b3c4d". Never
 *  resolved to a live row — origin outlives its source, so the breadcrumb is
 *  all the tab may honestly show. */
export function workOriginLabel(item: WorkItem): string {
  if (!item.originKind) return "—";
  if (!item.originId) return item.originKind;
  const id =
    item.originId.length > 8 ? item.originId.slice(0, 8) : item.originId;
  return `${item.originKind} · ${id}`;
}

export interface WorkProjectGroup {
  /** The `project_path` facet; null is the "(no project)" bucket. */
  project: string | null;
  items: WorkItem[];
  readyCount: number;
}

/** Group the rollup's items by their project facet. Groups order by ready
 *  depth (most ready work first), then path, the no-project bucket last
 *  within a tie; inside a group items order by band (ready → blocked/deferred
 *  → claimed → held), preserving the DB's urgent-first order within a band. */
export function groupWorkByProject(
  items: WorkItem[],
  readyIds: Set<string>,
): WorkProjectGroup[] {
  const byProject = new Map<string | null, WorkItem[]>();
  for (const item of items) {
    const key = item.projectPath ?? null;
    const list = byProject.get(key) ?? [];
    list.push(item);
    byProject.set(key, list);
  }
  const groups: WorkProjectGroup[] = [];
  for (const [project, members] of byProject) {
    const ranked = members
      .map((item, i) => ({ item, i, rank: workItemRank(item, readyIds) }))
      .sort((a, b) => a.rank - b.rank || a.i - b.i)
      .map((r) => r.item);
    groups.push({
      project,
      items: ranked,
      readyCount: members.filter((m) => readyIds.has(m.id)).length,
    });
  }
  return groups.sort(
    (a, b) =>
      b.readyCount - a.readyCount ||
      Number(a.project === null) - Number(b.project === null) ||
      (a.project ?? "").localeCompare(b.project ?? ""),
  );
}
