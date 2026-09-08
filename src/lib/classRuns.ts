// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// The gardener's runs, reversible (Session B2 of the Polis extraction): the
// shapes `classmem_runs` / `classmem_run` / `classmem_revert_run` return
// (camelCase, the same JSON as `GET /v1/memory/runs*`), and the pure
// derivations the run timeline renders from. Nothing here talks to Tauri.

/** One `class_runs` row: an organize / compaction / observations / revert run. */
export interface RunRow {
  id: number;
  startedAt: number;
  finishedAt: number | null;
  /** `running | done | error` — the legacy column; `outcome` is the truth. */
  status: string;
  seqFrom: number | null;
  seqTo: number | null;
  summary: string | null;
  durationMs: number | null;
  items: number | null;
  /** Ops applied (journaled) by the run. */
  ops: number | null;
  model: string | null;
  /** `done | error | reverted | reverted_by_canary`. */
  outcome: string | null;
  canaryBefore: number | null;
  canaryAfter: number | null;
  error: string | null;
  /** `organize | compaction | observations | revert | curation`. */
  mode: string | null;
  llmCalls: number | null;
  promptBytes: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  wallMs: number | null;
  canaryJson: string | null;
}

/** One journaled op of a run, without its image blobs. */
export interface RunOp {
  runId: number;
  opIx: number;
  /** `file | create | promote | split | merge | collapse | supersede | compact | observe`. */
  op: string;
  /** `node:<id>` / `link:<id>` / `obs:<id>` / `prompt:<id>` / `seq:<n>`. */
  subjectIds: string[];
  /** `applied | refused | expired | reverted`. */
  outcome: string;
  reason: string | null;
  preHash: string | null;
  ledgerSeq: number | null;
  revertedByRun: number | null;
}

export interface RunView {
  run: RunRow;
  ops: RunOp[];
}

export interface RevertReceipt {
  runId: number;
  revertedOps: number;
  eventSeq: number;
  revertRunId: number;
}

export const MODE_LABEL: Record<string, string> = {
  organize: "Organize",
  compaction: "Compaction",
  observations: "Observations",
  revert: "Undo",
  curation: "Curation",
};

export function modeLabel(run: Pick<RunRow, "mode">): string {
  return run.mode ? (MODE_LABEL[run.mode] ?? run.mode) : "Run";
}

export const RUN_OP_LABEL: Record<string, string> = {
  file: "File",
  create: "Create",
  promote: "Promote",
  split: "Split",
  merge: "Merge",
  collapse: "Collapse",
  supersede: "Supersede",
  compact: "Compact",
  observe: "Observe",
};

export function opLabel(op: string): string {
  return RUN_OP_LABEL[op] ?? op;
}

/** `node:abc` → `class abc`; `seq:12` → `#12`; `link:3` → `link 3`. */
export function subjectLabel(subject: string): string {
  const [kind, ...rest] = subject.split(":");
  const id = rest.join(":");
  switch (kind) {
    case "seq":
      return `#${id}`;
    case "node":
      return `class ${id}`;
    case "prompt":
      return `prompt ${id}`;
    case "link":
      return `link ${id}`;
    case "obs":
      return `observation ${id}`;
    default:
      return subject;
  }
}

/** The tone a run's outcome renders in: `ok | warn | muted`. */
export function outcomeTone(run: Pick<RunRow, "outcome" | "status">): "ok" | "warn" | "muted" {
  const o = run.outcome ?? run.status;
  if (o === "error") return "warn";
  if (o === "reverted" || o === "reverted_by_canary" || o === "running") return "muted";
  return "ok";
}

export function outcomeLabel(run: Pick<RunRow, "outcome" | "status">): string {
  const o = run.outcome ?? run.status;
  switch (o) {
    case "reverted":
      return "undone";
    case "reverted_by_canary":
      return "undone by the canary";
    case "done":
      return "applied";
    default:
      return o;
  }
}

/** One line for the collapsed header: `Organize · 4 ops · applied · 1.2 s`. */
export function runHeadline(run: RunRow): string {
  const parts = [modeLabel(run)];
  if (run.ops != null) parts.push(`${run.ops} op${run.ops === 1 ? "" : "s"}`);
  parts.push(outcomeLabel(run));
  const ms = run.wallMs ?? run.durationMs;
  if (ms != null) parts.push(ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`);
  return parts.join(" · ");
}

export interface UndoState {
  can: boolean;
  /** Why not, when `can` is false — shown in place of the button. */
  why?: string;
}

/**
 * Can this run be undone from what the surface already knows? The store is
 * the authority (a later overlapping run, the vacuum horizon and a missing
 * image are its refusals, shown inline when it says so); this only spares a
 * round-trip for the cases the row itself settles.
 */
export function undoState(run: RunRow, horizonRun?: number | null): UndoState {
  const o = run.outcome ?? run.status;
  if (o === "running") return { can: false, why: "still running" };
  if (o === "reverted" || o === "reverted_by_canary") return { can: false, why: "already undone" };
  if (run.mode === "revert") return { can: false, why: "an undo is its own run; undo the run it reverted instead" };
  if (run.ops != null && run.ops === 0) return { can: false, why: "nothing to undo" };
  if (horizonRun != null && run.id <= horizonRun) {
    return { can: false, why: `past the revert horizon (through run #${horizonRun})` };
  }
  return { can: true };
}

/**
 * The reason inside a refused revert. The command's error string is the
 * store's `MemoryError` rendered — `rejected: revert run #12 first — …` —
 * and the surface shows the reason, not the tag.
 */
export function refusalReason(err: unknown): string {
  const s = (err instanceof Error ? err.message : String(err)).trim();
  const m = /^(?:rejected|unavailable|store):\s*(.*)$/s.exec(s);
  return (m ? m[1] : s).trim() || "the store refused the undo";
}
