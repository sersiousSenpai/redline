// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { invoke } from "@tauri-apps/api/core";

// The agent shelf (harness program A3): typed wrappers over the A2
// `harness_agent_*` commands plus the pure list shaping the AgentShelf
// component renders from. An agent is a name and a plain-English
// instruction — the instruction IS the agent; running one lands its edits
// as tracked suggestions on the open document, never as applied bytes.

/** One user-authored agent row (`harness_agents`, serialized camelCase). */
export interface HarnessAgent {
  agentId: string;
  name: string;
  instruction: string;
  folderId: string | null;
  starred: boolean;
  createdAt: number;
  updatedAt: number;
  lastRunAt: number | null;
  runCount: number;
}

export const listAgents = () => invoke<HarnessAgent[]>("harness_agent_list");

export const createAgent = (name: string, instruction: string) =>
  invoke<HarnessAgent>("harness_agent_create", { name, instruction });

export const updateAgent = (
  agentId: string,
  name: string,
  instruction: string,
) => invoke<void>("harness_agent_update", { agentId, name, instruction });

export const starAgent = (agentId: string, starred: boolean) =>
  invoke<void>("harness_agent_set_starred", { agentId, starred });

export const moveAgent = (agentId: string, folderId: string | null) =>
  invoke<void>("harness_agent_set_folder", { agentId, folderId });

export const deleteAgent = (agentId: string) =>
  invoke<void>("harness_agent_delete", { agentId });

export const duplicateAgent = (agentId: string) =>
  invoke<HarnessAgent>("harness_agent_duplicate", { agentId });

/** Run a saved agent against the open document. `draftMarkdown` is the LIVE
 *  editor mirror when the pane is open (flushed server-side before the run,
 *  exactly like `draft_instruct`); null falls back to the stored mirror. */
export const runAgent = (i: {
  agentId: string;
  draftId: string;
  draftMarkdown: string | null;
  projectPath: string | null;
  cwd: string | null;
}) => invoke<void>("harness_agent_run", i);

/** Rehearse an UNSAVED instruction against a copy of the open document.
 *  Returns the preview draft's id — subscribe to its `drafter-suggestion` /
 *  `draft-chat-*` events, then discard it. */
export const previewAgent = (i: {
  name: string;
  instruction: string;
  draftId: string;
  draftMarkdown: string | null;
  projectPath: string | null;
  cwd: string | null;
}) => invoke<string>("harness_agent_preview", i);

export const discardPreview = (previewId: string) =>
  invoke<void>("harness_preview_discard", { previewId });

/** Kill a draft's in-flight turn (the preview's, when a rehearsal is thrown
 *  away mid-run). The existing drafter cancel command, aimed at the copy. */
export const cancelDraftTurn = (draftId: string) =>
  invoke<void>("draft_chat_cancel", { draftId });

/** Starred first; inside each band the backend's most-recently-updated order
 *  is preserved (the sort is stable). */
export function shelfOrder(agents: HarnessAgent[]): HarnessAgent[] {
  return [...agents].sort(
    (a, b) => Number(b.starred) - Number(a.starred),
  );
}

/** Case-insensitive substring filter over name and instruction. */
export function filterAgents(
  agents: HarnessAgent[],
  query: string,
): HarnessAgent[] {
  const q = query.trim().toLowerCase();
  if (!q) return agents;
  return agents.filter(
    (a) =>
      a.name.toLowerCase().includes(q) ||
      a.instruction.toLowerCase().includes(q),
  );
}

/** "never run" / "ran once" / "ran 4×" — the row's quiet run history. */
export function runSummary(a: HarnessAgent): string {
  if (a.runCount <= 0) return "never run";
  if (a.runCount === 1) return "ran once";
  return `ran ${a.runCount}×`;
}
