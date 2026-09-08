// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

// The ClassMemory catalog's shared client vocabulary: node/link/observation
// shapes as the backend serializes them, plus the pure tree/ordering helpers.
// Extracted from the retired ClassMemoryPane (the `portability.ts` precedent).
// Since B3 the catalog is read-only: the gardener adjudicates on its own, its
// structural proposals sit in a work queue "waiting for a run", and the run
// is what a person undoes (the RunTimeline) — so nothing here models a verdict.

export interface ClassNode {
  id: string;
  parentId: string | null;
  kind: string; // "node" | "digest"
  title: string;
  summary: string | null;
  projectPath: string | null;
  ipName: string | null;
  status: string; // "accepted" — B3 stages live rows; nothing waits for a verdict
  /** Wire-compatible; B3 retired pins (protection is warmth or a note). */
  pinned: boolean;
  curatedBy: string | null;
  createdAt: number;
  updatedAt: number;
  linkCount: number;
}

export interface TreeNode extends ClassNode {
  children: TreeNode[];
}

/** One filed pointer as `build_node_view` serializes it (a flattened
 *  `ClassLink` + display label + supersession annotation). */
export interface LinkView {
  id: number;
  nodeId: string;
  targetKind: string;
  targetId: string;
  note: string | null;
  status: string;
  createdAt: number;
  label: string | null;
  /** The decision seq that superseded this link's target (null = current). */
  supersededBy: number | null;
}

/** An agent-derived pattern note on a node — never ground truth. */
export interface Observation {
  id: number;
  nodeId: string;
  summary: string;
  citeSeqs: number[];
  createdSeq: number | null;
  /** Wire-compatible; B3 retired pins and dismissals — a retired observation
   *  is simply absent from `classmem_node`. */
  pinned: boolean;
  dismissed: boolean;
  createdAt: number;
}

export interface Citation {
  seq: number;
  label: string | null;
}

/** One row of the gardener's work queue (B3): a structural proposal the next
 *  run adjudicates — due now, or deferred with backoff after a failed verify. */
export interface ProposalView {
  id: number;
  op: string;
  nodeId: string | null;
  parentId: string | null;
  title: string | null;
  summary: string | null;
  extraJson: string | null;
  rationale: string | null;
  status: string;
  createdAt: number;
  /** Verifier attempts so far (expires after 3). */
  attempts: number;
  /** The run id this row waits for; null = due on the next run. */
  nextAfterRun: number | null;
  /** The lake `ts` past which the row expires unapplied (7 lake-days). */
  expiresLakeTs: number | null;
  nodeTitle: string | null;
  citations: Citation[];
}

/** `memory_catalog_health` — the gardener's efficacy (plan §6.3), mirroring
 *  `polis_core::types::CatalogHealth`. */
export interface CatalogHealth {
  runsConsidered: number;
  organizeP50Ms: number | null;
  organizeP90Ms: number | null;
  errorRate: number;
  canaryReverts: number;
  canaryTrend: number[];
  canaryAlert: boolean;
  maxFanOut: number;
  nodesOver150: number;
  nodesOver120: number;
  digestRatio: number;
  orphanRate: number;
  depthHistogram: number[];
  duplicateTitleRate: number;
  provenanceViolations: number;
  noModelShare: number;
  unacknowledgedRedactions: number;
  queueDepth: number;
  liveObservations: number;
}

export interface ClassRun {
  id: number;
  startedAt: number;
  finishedAt: number | null;
  status: string;
  summary: string | null;
}

export const OP_LABEL: Record<string, string> = {
  promote: "Promote",
  split: "Split",
  merge: "Merge",
  collapse: "Collapse",
  supersede: "Supersede",
};

/**
 * Build the nested tree from the flat node list (a class is a root — parentId
 * null; a node whose parent is missing is also surfaced as a root so nothing is
 * lost). Pure, so it's unit-tested. Order is preserved from the server (title-
 * sorted); B3 retired pins, so nothing floats above its siblings any more.
 */
export function buildTree(nodes: ClassNode[]): TreeNode[] {
  const byId = new Map<string, TreeNode>();
  for (const n of nodes) byId.set(n.id, { ...n, children: [] });
  const roots: TreeNode[] = [];
  for (const node of byId.values()) {
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const sortGroup = (a: TreeNode, b: TreeNode) => a.title.localeCompare(b.title);
  const sortRec = (list: TreeNode[]) => {
    list.sort(sortGroup);
    for (const n of list) sortRec(n.children);
  };
  sortRec(roots);
  return roots;
}

/**
 * "#5 → #12" for a supersede proposal's extraJson ({"old_seq":5,"new_seq":12}).
 * Null on missing/malformed payloads. Pure, so it's unit-tested.
 */
export function supersedeLabel(extraJson: string | null): string | null {
  if (!extraJson) return null;
  try {
    const v = JSON.parse(extraJson) as { old_seq?: unknown; new_seq?: unknown };
    if (typeof v.old_seq !== "number" || typeof v.new_seq !== "number") return null;
    return `#${v.old_seq} → #${v.new_seq}`;
  } catch {
    return null;
  }
}

/**
 * Display order for a node's observations: newest first. Retired ones are
 * absent from the API (B3); a legacy `dismissed` row is still filtered
 * defensively. Pure, so it's unit-tested.
 */
export function sortObservations(obs: Observation[]): Observation[] {
  return obs
    .filter((o) => !o.dismissed)
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt || b.id - a.id);
}

/** Descendant count — what a collapsed chevron is hiding. Pure. */
export function countDescendants(node: TreeNode): number {
  return node.children.reduce((sum, c) => sum + 1 + countDescendants(c), 0);
}

/**
 * The queue card's headline for a proposal: the subject node's title when the
 * op targets a node, the proposed title otherwise, the "#old → #new" pair for a
 * supersede, and the row id as the last resort. Pure, so it's unit-tested.
 */
export function proposalSubject(p: ProposalView): string {
  return (
    p.nodeTitle ??
    p.title ??
    (p.op === "supersede" ? supersedeLabel(p.extraJson) : null) ??
    `proposal #${p.id}`
  );
}

/** How many verifier attempts a queued proposal gets before it expires
 *  (`polis_store::runs::PROPOSAL_TTL_ATTEMPTS`). */
export const PROPOSAL_TTL_ATTEMPTS = 3;

/**
 * Where a proposal sits in the gardener's work queue (B3) — the line the
 * queue card shows instead of a verdict: "waiting for the next run" when it
 * is due, the attempt count and the run it was deferred behind after a failed
 * verify, its status word otherwise (applied / refused / expired rows never
 * reach the surface, but the shape is defensive). Pure, so it's unit-tested.
 */
export function queueLine(
  p: Pick<ProposalView, "status" | "attempts" | "nextAfterRun">,
): string {
  if (p.status !== "pending") return p.status;
  const due = p.nextAfterRun == null ? "waiting for the next run" : `due after run #${p.nextAfterRun}`;
  if (p.attempts <= 0) return due;
  return `${due} · attempt ${p.attempts} of ${PROPOSAL_TTL_ATTEMPTS} failed to verify`;
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

/**
 * The Health tab's rows for `memory_catalog_health` (plan §6.3), each as the
 * `Field` primitive's label/value pair. Pure, so it's unit-tested; the shape
 * is the report, not a judgement — except the canary alert, which is the one
 * line that must not read as a neutral number.
 */
export function catalogHealthFields(h: CatalogHealth): { label: string; value: string }[] {
  const ms = (v: number | null) => (v == null ? "—" : `${v.toLocaleString()}ms`);
  const trend = h.canaryTrend.slice(-5).map((v) => pct(v)).join(" ");
  return [
    {
      label: "Runs",
      value: `${h.runsConsidered} considered · organize p50 ${ms(h.organizeP50Ms)} · p90 ${ms(h.organizeP90Ms)}`,
    },
    { label: "Errors", value: `${pct(h.errorRate)} of runs` },
    {
      label: "Canary",
      value:
        `${h.canaryReverts} revert${h.canaryReverts === 1 ? "" : "s"}` +
        (trend ? ` · regressions ${trend}` : "") +
        (h.canaryAlert ? " · ALERT — regressions are rising" : ""),
    },
    {
      label: "Fan-out",
      value: `max ${h.maxFanOut} · ${h.nodesOver150} over 150 · ${h.nodesOver120} over 120`,
    },
    {
      label: "Shape",
      value: `digests ${pct(h.digestRatio)} · orphans ${pct(h.orphanRate)} · duplicate titles ${pct(h.duplicateTitleRate)}`,
    },
    {
      label: "Depth",
      value: h.depthHistogram.length ? h.depthHistogram.map((n, i) => `d${i}:${n}`).join(" ") : "—",
    },
    { label: "Provenance", value: `${h.provenanceViolations} cross-root filing${h.provenanceViolations === 1 ? "" : "s"}` },
    { label: "Lineage", value: `${pct(h.noModelShare)} of prompts without a model` },
    { label: "Redactions", value: `${h.unacknowledgedRedactions} unacknowledged` },
    { label: "Queue", value: `${h.queueDepth} waiting for a run` },
    { label: "Patterns", value: `${h.liveObservations} live` },
  ];
}
