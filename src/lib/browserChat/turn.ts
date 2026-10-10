// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

// What rides each page-chat turn, what the composer may do, what a reply
// offers, and how a turn in flight is drawn. Pure. BrowserChat renders these,
// and its `buildSendArgs` returns `turnEnvelope(...)` (plus the snapshot when
// `needsSnapshot` says so) verbatim to `browse_send`.
//
// Rule ids (BC-n) are catalogued in invariants.ts.

import type { TurnPhase } from "../agentTurn";
import type { Activity } from "../turnMeter";
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
  canQueue: boolean;
  /** Inject into the running turn. Browse has no steer route yet (BC-29). */
  canSteer: false;
  /** The model picker stays live; a change applies to the next message (BC-25). */
  pickerLive: true;
  placeholder: string;
}

export function composerModel(i: { phase: TurnPhase; queued: number; draft: string }): ComposerModel {
  const streaming = i.phase === "streaming";
  const typed = i.draft.trim().length > 0;
  const canQueue = !streaming || i.queued < QUEUE_CAP;
  return {
    editable: true,
    enterSends: true,
    primary: streaming ? "queue" : "send",
    primaryIsStop: streaming && !typed,
    primaryEnabled: streaming ? !typed || canQueue : typed,
    canQueue,
    canSteer: false,
    pickerLive: true,
    placeholder: streaming ? "Type ahead — sends after this reply" : "Ask about this page",
  };
}

/** Context the composer shows as chips above the textarea. The page chip is
 *  the turn's TARGET and is always present (it changes as a shared chat
 *  follows tabs); a highlight or a picked element is attached by the gesture
 *  that made it and can be removed; the mission shows only inside a mission
 *  workspace (BC-13, BC-14, BC-15). */
export type ContextPill =
  | { kind: "page"; label: string; removable: false }
  | { kind: "selection"; label: string; removable: true }
  | { kind: "element"; label: string; removable: true }
  | { kind: "mission"; label: string; removable: false };

export function contextPills(i: {
  conv: ResolvedConversation;
  selection?: string | null;
  element?: string | null;
  missionTitle?: string | null;
}): ContextPill[] {
  const page = `${i.conv.targetNumber} · ${i.conv.targetTitle || "This page"}`;
  const pills: ContextPill[] = [{ kind: "page", label: clip(page), removable: false }];
  if (i.selection?.trim()) pills.push({ kind: "selection", label: clip(i.selection.trim()), removable: true });
  if (i.element?.trim()) pills.push({ kind: "element", label: clip(i.element.trim()), removable: true });
  if (i.missionTitle?.trim()) pills.push({ kind: "mission", label: clip(i.missionTitle.trim()), removable: false });
  return pills;
}
const clip = (s: string) => (s.length > 40 ? `${s.slice(0, 39)}…` : s);

// --- reply actions ----------------------------------------------------------

export type ReplyAction = "copy" | "add-to-task-list" | "add-to-mission" | "continue-as";

/** What a settled reply offers, in order. User gestures only: the agent never
 *  pins, files or launches on its own (BC-24). Handing off to the Drafter or
 *  a new plan lives inside Continue as… (one door, not three buttons). */
export function replyActions(i: { role: string; status: string; body: string; missionActive: boolean }): ReplyAction[] {
  if (i.role !== "assistant" || i.status !== "complete" || !i.body.trim()) return [];
  return ["copy", "add-to-task-list", ...(i.missionActive ? (["add-to-mission"] as const) : []), "continue-as"];
}

// --- a turn in flight -------------------------------------------------------

export type ActivityStep = Pick<Activity, "kind" | "label">;

export type StreamPart =
  | { kind: "pending"; label: string }
  | { kind: "steps"; steps: ActivityStep[]; collapsed: true; current: string }
  | { kind: "text"; text: string };

/** How the in-flight reply is drawn: as the reply itself, not boxes around it
 *  (BC-34). Before anything arrives there is exactly ONE pending line; tool
 *  use folds into one compact, collapsed steps row naming the current step;
 *  once text arrives it is the only growing element. Badges and meters live
 *  in the composer footer or on hover, never in the stream. */
export function streamParts(i: {
  phase: TurnPhase;
  liveText: string;
  activity: readonly ActivityStep[];
  rateLimited?: boolean;
}): StreamPart[] {
  if (i.phase !== "streaming") return [];
  const parts: StreamPart[] = [];
  const steps = i.activity.filter((a) => a.kind === "tool");
  if (steps.length) parts.push({ kind: "steps", steps: [...steps], collapsed: true, current: steps[steps.length - 1].label });
  if (i.liveText) parts.push({ kind: "text", text: i.liveText });
  else if (!steps.length) parts.push({ kind: "pending", label: i.rateLimited ? "Waiting on a rate limit" : i.activity[i.activity.length - 1]?.label ?? "Working" });
  return parts;
}
