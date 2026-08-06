// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

// The ClassMemory catalog's shared client vocabulary: node/link/observation
// shapes as the backend serializes them, plus the pure tree/ordering helpers.
// Extracted from the retired ClassMemoryPane (the `portability.ts` precedent);
// the P2 Catalog cockpit re-plumbs its review UI on top of these.

export interface ClassNode {
  id: string;
  parentId: string | null;
  kind: string; // "node" | "digest"
  title: string;
  summary: string | null;
  projectPath: string | null;
  ipName: string | null;
  status: string; // "proposed" | "accepted"
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
  pinned: boolean;
  dismissed: boolean;
  createdAt: number;
}

export interface Citation {
  seq: number;
  label: string | null;
}

/** A staged classifier proposal (the held-review strip's row shape). */
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
  nodeTitle: string | null;
  citations: Citation[];
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
 * sorted), with pinned nodes floated to the top of each sibling group.
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
  const sortGroup = (a: TreeNode, b: TreeNode) =>
    Number(b.pinned) - Number(a.pinned) || a.title.localeCompare(b.title);
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
 * Display order for a node's observations: pinned first (promoted into the
 * node's permanent context), then newest first; dismissed filtered defensively
 * (the API already excludes them). Pure, so it's unit-tested.
 */
export function sortObservations(obs: Observation[]): Observation[] {
  return obs
    .filter((o) => !o.dismissed)
    .slice()
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.createdAt - a.createdAt || b.id - a.id);
}

/** Descendant count — what a collapsed chevron is hiding. Pure. */
export function countDescendants(node: TreeNode): number {
  return node.children.reduce((sum, c) => sum + 1 + countDescendants(c), 0);
}

/**
 * The review strip's headline for a proposal: the subject node's title when the
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
