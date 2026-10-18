// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The flow shell's start screen — the New-session screen, which is the Front
//! Door in flow mode — and its pure rules: which of its two modes the composer
//! is in, what ⏎ and ⌘⏎ send, how the model chip reads, which sessions it
//! offers to continue, whether the four-step strip still shows, and where the
//! floating "Plan a build" pill belongs. House style, as lib/frontDoor.ts:
//! every decision lives here so it is testable without a DOM; FrontDoor.tsx
//! renders and App.tsx wires.
//!
//! Kept small and dependency-light on purpose: FrontDoor is on the boot path,
//! and this is the part of flow mode it cannot load lazily.

import { backendLabel, modelsFor, type BackendChoice, type ModelCatalogs } from "./backendChoice";
import type { LaunchDestination, SubmitKeyInfo } from "./frontDoor";
import type { SessionSummary } from "../types";

/** The window event that opens the start screen, for whatever outside App's
 *  own handlers asks for a new session (the native menu's Getting Started,
 *  a key bound elsewhere). `detail.via` is "key" for a keyboard summons,
 *  which arrives with the caret in the box (zoomed); anything else arrives
 *  quiet. App's `openStartScreen` is the same thing, called directly. */
export const NEW_SESSION_EVENT = "redline:new-session";

/** The start screen's two modes, the segmented control above its prompt.
 *  The door's other two destinations left it in flow: the Drafter is a Tools
 *  page (⌘2) and a direct run is ⌘↩. */
export type FlowMode = "chat" | "plan";

/** The door's sticky destination, as the start screen reads it. A Drafter or
 *  Run destination left over from the classic shell is not a mode here, so it
 *  reads as the default, Plan. */
export function flowMode(destination: LaunchDestination): FlowMode {
  return destination === "chat" ? "chat" : "plan";
}

/** What a key in the start screen's prompt sends.
 *
 *  ⏎ sends to the selected mode and ⇧⏎ is a newline, as everywhere. ⌘⏎ is
 *  the direct run — "just do it", with no plan — where the harness offers one
 *  (`runSupported`); where it doesn't, the modifier changes nothing rather
 *  than reaching for a destination the screen no longer shows. */
export function flowSubmitAction(
  e: SubmitKeyInfo,
  mode: FlowMode,
  runEnabled: boolean,
): LaunchDestination | "newline" | "ignore" {
  if (e.key !== "Enter" || e.isComposing) return "ignore";
  if (e.metaKey || e.ctrlKey) return runEnabled ? "run" : mode;
  if (e.shiftKey) return "newline";
  return mode;
}

/** An effort level as the chip and the effort menu say it. */
export function effortLabel(effort: string): string {
  return effort === "xhigh" ? "Extra high" : effort.charAt(0).toUpperCase() + effort.slice(1);
}

/** The model chip's words: "Opus · High", or "Codex · GPT-5.5 · Medium" when
 *  more than one harness is installed — the chip has to say who will do the
 *  work when that is a real question. With no model picked it names the
 *  harness and its default, so the chip is never just an effort. The model's
 *  name comes from the live catalog, never a list baked in here. */
export function flowModelLabel(
  choice: BackendChoice,
  catalogs: ModelCatalogs,
  showHarness: boolean,
): string {
  const parts: string[] = [];
  if (showHarness || !choice.model) parts.push(backendLabel(choice.backend));
  if (choice.model) parts.push(modelsFor(choice.backend, catalogs).find((m) => m.value === choice.model)?.label ?? choice.model);
  if (choice.effort) parts.push(effortLabel(choice.effort));
  else if (!choice.model) parts.push("Default");
  return parts.join(" · ");
}

/** A folder as the folder chip shows it: under the home directory, from `~`.
 *  Display only — the path itself is never rewritten — so a heuristic on the
 *  two home layouts the app runs on is enough. Null is the Home fallback. */
export function tildePath(path: string | null): string {
  if (!path) return "~";
  const trimmed = path.replace(/\/+$/, "") || "/";
  return trimmed.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");
}

export interface ContinueLink {
  id: string;
  title: string;
}

/** The start screen's way back in, now that the recents live in the sidebar:
 *  at most a couple of "Continue <title>" links to the most recent sessions
 *  still in review — not approved, not abandoned, not archived. */
export function continueLinks(summaries: readonly SessionSummary[], max = 2): ContinueLink[] {
  return summaries
    .filter((s) => s.status === "in_review" && !s.archivedAt)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, max)
    .map((s) => ({
      id: s.sessionId,
      title: s.titleOverride?.trim() || s.planTitle?.trim() || s.projectName,
    }));
}

/** Whether any session has been approved — the moment the four-step strip has
 *  done its job. A run on a session is an approval too, and a manual state
 *  set later does not undo that it happened. App remembers the first time
 *  this is true, so deleting that session never brings the strip back. */
export function anyApproved(summaries: readonly SessionSummary[]): boolean {
  return summaries.some((s) => s.status === "approved" || !!s.runState);
}

/** Where the floating "Plan a build" pill shows in the flow shell: the Tools
 *  pages only. The session stage and the start screen have their own
 *  composer, and a second way in floating over it would be one too many. */
export function flowPillShown(surface: string): boolean {
  return surface !== "document" && surface !== "chat";
}
