// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

// Shared ledger-row vocabulary: the event/verdict shapes the backend serializes
// (`ledger::LedgerEventRow` / `ledger::ChainVerdict`) and the kind → label /
// color maps every memory surface renders with. Extracted from the retired
// LedgerPane so the Memory surface, the inspector and the pill stop re-declaring
// them (the `portability.ts` precedent).

/** Mirror of `ledger::LedgerEventRow` (camelCase over the wire). */
export interface LedgerEvent {
  seq: number;
  ts: number;
  kind: string;
  author: string;
  promptId: number | null;
  sessionId: string | null;
  versionNumber: number | null;
  refKind: string | null;
  refId: string | null;
  payloadHash: string;
  prevHash: string;
  entryHash: string;
}

/** Mirror of `ledger::ChainVerdict` (the `ledger_verify` command). */
export interface ChainVerdict {
  ok: boolean;
  checked: number;
  firstBadSeq: number | null;
  headHash: string | null;
}

export const KIND_LABEL: Record<string, string> = {
  prompt: "Prompt",
  revision: "Revision",
  resolution: "Resolution",
  approval: "Approval",
  reopen: "Reopen",
  review_verdict: "Review verdict",
  pin: "Pin",
  source_trust: "Source trust",
  taxonomy_reorg: "Taxonomy reorg",
  class_curate: "Class curate",
  compaction: "Compaction",
  browse_event: "Browse event",
  session_link: "Session link",
  supersede: "Supersede",
  observation: "Observation",
  note: "Note",
};

export const KIND_COLOR: Record<string, string> = {
  prompt: "#4f8cff",
  revision: "#7c5cff",
  resolution: "#2fae66",
  approval: "#2fae66",
  reopen: "#e0913a",
  review_verdict: "#c065d0",
  pin: "#d0a52f",
  source_trust: "#d0a52f",
  taxonomy_reorg: "#7c5cff",
  class_curate: "#2f9ea5",
  compaction: "#8a8f98",
  browse_event: "#3aa0c0",
  session_link: "#7a8fb0",
  supersede: "#c65d21",
  observation: "#3f9e8f",
  note: "#e3b341",
};

export function kindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? kind;
}

/** The verify-banner text for a chain verdict. Pure, so it's unit-tested. */
export function describeVerdict(v: ChainVerdict): string {
  if (v.ok) {
    const base = `✓ Chain intact — ${v.checked} event${v.checked === 1 ? "" : "s"} verified`;
    return v.headHash ? `${base} · head ${v.headHash.slice(0, 12)}…` : base;
  }
  return `✕ Chain broken at seq ${v.firstBadSeq} (verified ${v.checked} before the break)`;
}

/** "Aug 3, 09:12"-style timestamp for ledger rows. */
export function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
