// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

// What rides each page-chat turn, what the composer may do and what a reply
// offers. Pure. BrowserChat renders these, and its `buildSendArgs` returns
// `turnEnvelope(...)` (plus the snapshot when `needsSnapshot` says so)
// verbatim to `browse_send`. How a turn is drawn is transcript.ts.
//
// Rule ids (BC-n) are catalogued in invariants.ts.

import type { TurnPhase } from "../agentTurn";
import contract from "./contract.json";
import { workspaceKind, type ResolvedConversation, type WorkspaceKey } from "./scope";

// --- the envelope -----------------------------------------------------------

/** The workspace a turn is CAPTURED under, as `browse_send` reads it: a
 *  mission id, or "regular" for anything that is not a mission (BC-13). The
 *  backend also reads a `mosaic:` id as no mission; sending "regular" keeps
 *  the wire saying exactly what the turn is. */
export function capturedWorkspace(key: WorkspaceKey): string {
  return workspaceKind(key) === "mission" ? key : "regular";
}

export interface GroundingInputs {
  /** Provider that wrote the thread's latest completed reply; null = none yet. */
  lastReplyBackend: string | null;
  /** Provider this turn runs on (the chat's pick, committed before send). */
  runsOn: string;
  /** Target label the conversation last SENT a snapshot for; null after a
   *  remount (re-grounding is the safe default). */
  lastGroundedLabel: string | null;
}

/** Whether this turn embeds a page snapshot (BC-11): until a session on THIS
 *  provider has answered (the backend keeps a session only once it answers),
 *  and whenever the target page changed since the last grounding (a shared
 *  chat following tabs, an agent-opened tab). */
export function needsSnapshot(conv: ResolvedConversation, g: GroundingInputs): boolean {
  return g.lastReplyBackend !== g.runsOn || g.lastGroundedLabel !== conv.targetLabel;
}

/** `browse_send`'s arguments, minus `queue` (the turn hook adds it). The key
 *  set is pinned against the Rust command's parameters by wiring.test.ts. */
export interface TurnEnvelope {
  browseId: string;
  text: string;
  targetLabel: string;
  followingTabs: boolean;
  workspaceId: string;
  cwd: string | null;
  /** From `captureSnapshotOrCached(targetLabel)` when `needsSnapshot`: a live
   *  read of the TARGET only, the cache for a suspended one. */
  snapshot?: string;
}

/** Captured when the user sends, not when the turn starts: a queued turn
 *  keeps the page, scope and workspace it was typed against (BC-12). */
export function turnEnvelope(
  conv: ResolvedConversation,
  workspace: WorkspaceKey,
  text: string,
  cwd: string | null,
  snapshot?: string,
): TurnEnvelope {
  return {
    browseId: conv.browseId,
    text,
    targetLabel: conv.targetLabel,
    followingTabs: conv.scope === "following-tabs",
    workspaceId: capturedWorkspace(workspace),
    cwd,
    ...(snapshot ? { snapshot } : {}),
  };
}

// --- seeds: text that arrives in the composer from elsewhere -----------------

export type SeedSource =
  /** `note` is what the user typed into the in-page bar's inline Ask. */
  | { kind: "selection"; action: "ask" | "define" | "explain" | "research"; note?: string }
  | { kind: "selection-list" }
  | { kind: "element" }
  | { kind: "task-item" }
  | { kind: "plan-search" };

export interface SeedPolicy {
  /** Becomes a chat turn at all (＋ List writes to the Task list instead). */
  toChat: boolean;
  /** Sends at once, being already a complete instruction (BC-14). It waits
   *  for the thread to finish restoring before it goes. */
  autoSend: boolean;
  /** Places the caret in the composer, only when the gesture's whole point
   *  is for the user to type next (BC-33). */
  focusComposer: boolean;
  /** Merges below whatever the user had half-typed; never replaces it. */
  mergesDraft: boolean;
}

export function seedPolicy(s: SeedSource): SeedPolicy {
  switch (s.kind) {
    case "selection-list":
      return { toChat: false, autoSend: false, focusComposer: false, mergesDraft: false };
    case "selection": {
      const intent = (contract.selectionIntents as Record<string, { autoSend: boolean }>)[s.action];
      // An inline Ask that already carries the question is complete too.
      const autoSend = (intent?.autoSend ?? false) || !!s.note?.trim();
      return { toChat: true, autoSend, focusComposer: !autoSend, mergesDraft: !autoSend };
    }
    case "element":
    case "task-item":
      return { toChat: true, autoSend: false, focusComposer: true, mergesDraft: true };
    case "plan-search":
      // The user is in a plan; the research turn goes out in a fresh tab's
      // own chat without moving their caret.
      return { toChat: true, autoSend: true, focusComposer: false, mergesDraft: false };
  }
}

// --- the composer -----------------------------------------------------------

/** turn.rs `QUEUE_CAP`, pinned by both languages' tests. */
export const QUEUE_CAP: number = contract.queueCap;

export interface ComposerModel {
  /** Never disabled, in any phase (BC-27). */
  editable: true;
  /** Enter sends; mid-stream it queues. Shift+Enter is a newline. */
  enterSends: true;
  primary: "send" | "queue";
  /** Send and Stop are one morphing control: Stop shows only while streaming
   *  AND the draft is empty, and typing turns it back into Queue (BC-27, BC-34). */
  primaryIsStop: boolean;
  primaryEnabled: boolean;
  /** The one round button's face: the mic on an empty box, so speaking is
   *  one press away; send with something to send; queue with something to
   *  send while a reply runs; stop on an empty box while it runs. */
  button: "mic" | "send" | "queue" | "stop";
  canQueue: boolean;
  /** Inject into the running turn. Browse has no steer route yet (BC-29). */
  canSteer: false;
  /** The model picker stays live; a change applies to the next message (BC-25). */
  pickerLive: true;
  placeholder: string;
}

/** `chips` counts attached context: a quoted passage alone is a message.
 *  `canDictate` is false when the mic is someone else's. */
export function composerModel(i: { phase: TurnPhase; queued: number; draft: string; chips?: number; canDictate?: boolean }): ComposerModel {
  const streaming = i.phase === "streaming";
  const typed = i.draft.trim().length > 0 || (i.chips ?? 0) > 0;
  const canQueue = !streaming || i.queued < QUEUE_CAP;
  const primaryIsStop = streaming && !typed;
  return {
    editable: true,
    enterSends: true,
    primary: streaming ? "queue" : "send",
    primaryIsStop,
    primaryEnabled: streaming ? !typed || canQueue : typed,
    button: primaryIsStop ? "stop" : typed ? (streaming ? "queue" : "send") : i.canDictate === false ? "send" : "mic",
    canQueue,
    canSteer: false,
    pickerLive: true,
    placeholder: streaming ? "Type ahead — sends after this reply" : "Ask about this page",
  };
}

// --- reply actions ----------------------------------------------------------

export type ReplyAction = "copy" | "add-to-task-list" | "add-to-mission" | "continue-as";

/** What a settled reply offers, in order. User gestures only: the agent never
 *  pins, files or launches on its own (BC-24). Handing off to the Drafter or
 *  a new plan lives inside Continue as… (one door, not three buttons). */
export function replyActions(i: { role: string; status: string; body: string; missionActive: boolean }): ReplyAction[] {
  if (i.role !== "assistant" || i.status !== "complete" || !i.body.trim()) return [];
  return ["copy", "add-to-task-list", ...(i.missionActive ? (["add-to-mission"] as const) : []), "continue-as"];
}
