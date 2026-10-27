// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The flow shell's own UI state — what the top bar, the sidebar and the
//! stage all need to agree on, kept out of App's state so a toggle in the
//! top bar re-renders the pieces that read it and nothing else.
//!
//! - `stage`: what the session stage shows, the mirrored conversation or
//!   the session's own terminal at full stage (⌘J).
//! - `planPose`: per session — the plan panel closed, split beside the
//!   conversation, or full (the conversation moves into the panel's Chat
//!   tab). The rules that move it (a new revision opens it once, narrow
//!   windows make split full…) live in lib/flowPose.ts; this only stores.
//! - `panelTab`: in the full pose, the right panel's Chat or Feedback tab.
//! - `sidebar`: shown or collapsed (⌘B), remembered across launches.

import { useSyncExternalStore } from "react";

export type StageView = "conversation" | "terminal";
export type PlanPose = "closed" | "split" | "full";
export type PanelTab = "chat" | "feedback";

export interface FlowState {
  stage: StageView;
  planPose: Readonly<Record<string, PlanPose>>;
  panelTab: PanelTab;
  sidebar: boolean;
}

const SIDEBAR_KEY = "redline.flow.sidebar";

function readSidebar(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) !== "0";
  } catch {
    return true;
  }
}

let state: FlowState = {
  stage: "conversation",
  planPose: {},
  panelTab: "chat",
  sidebar: readSidebar(),
};
const listeners = new Set<() => void>();

function set(next: Partial<FlowState>): void {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Subscribe from outside React (`flowStateLazy` bridges App to this
 *  store once it has loaded). */
export const subscribeFlow = subscribe;

export function getFlowState(): FlowState {
  return state;
}

/** Subscribe to one slice; re-renders only when it changes (by `Object.is`). */
export function useFlow<T>(select: (s: FlowState) => T): T {
  return useSyncExternalStore(subscribe, () => select(state), () => select(state));
}

export function setStage(stage: StageView): void {
  if (state.stage !== stage) set({ stage });
}

export function toggleStage(): void {
  set({ stage: state.stage === "conversation" ? "terminal" : "conversation" });
}

/** A session with no stored pose is closed. */
export function planPoseOf(sessionId: string | null | undefined): PlanPose {
  return (sessionId && state.planPose[sessionId]) || "closed";
}

export function setPlanPose(sessionId: string, pose: PlanPose): void {
  if (planPoseOf(sessionId) === pose) return;
  set({ planPose: { ...state.planPose, [sessionId]: pose } });
}

export function setPanelTab(panelTab: PanelTab): void {
  if (state.panelTab !== panelTab) set({ panelTab });
}

export function setSidebar(sidebar: boolean): void {
  if (state.sidebar === sidebar) return;
  try {
    localStorage.setItem(SIDEBAR_KEY, sidebar ? "1" : "0");
  } catch {
    /* Remembered for this launch only. */
  }
  set({ sidebar });
}

export function toggleSidebar(): void {
  setSidebar(!state.sidebar);
}

/** Tests only. */
export function resetFlowStateForTests(next: Partial<FlowState> = {}): void {
  state = { stage: "conversation", planPose: {}, panelTab: "chat", sidebar: true, ...next };
  for (const listener of listeners) listener();
}
