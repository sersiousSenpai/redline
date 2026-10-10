// Synthetic boundary: no user database, model calls, or profile writes. A
// controllable turn store stands in for `useAgentTurn`, driven from the QA
// script through `window.__turn`; every Tauri interface is inert.
import { useSyncExternalStore } from "react";

export function useReadAloud() { return { speaking: false, stop: () => {}, speak: () => {} }; }
export function useDictation() { return { listening: false, partial: "", toggle: () => {} }; }
export async function listen() { return () => {}; }
export async function emit() {} export async function emitTo() {} export async function once() { return () => {}; }
export async function open() { return null; } export async function openUrl() {}
export function convertFileSrc(path: string) { return path; } export function isTauri() { return false; }
export function getCurrentWindow() { return { startDragging: async () => {}, toggleMaximize: async () => {} }; }
export function getCurrentWebview() { return { onDragDropEvent: async () => () => {} }; }
export class Webview {}
export class Channel { onmessage = () => {}; }

const noop = () => {};
type TurnState = Record<string, unknown>;
const store: { state: TurnState; subscribers: Set<() => void> } = {
  state: { messages: [], liveText: "", status: "idle", startedAt: null, loaded: true, meter: null, activity: [], meters: {}, queue: [], retrying: false },
  subscribers: new Set(),
};
const subscribe = (fn: () => void) => { store.subscribers.add(fn); return () => { store.subscribers.delete(fn); }; };
const snapshot = () => store.state;
Object.assign(window, { __turn: {
  set(patch: TurnState) { store.state = { ...store.state, ...patch }; for (const fn of store.subscribers) fn(); },
  get: () => store.state,
} });
export function useAgentTurn() {
  const state = useSyncExternalStore(subscribe, snapshot);
  return { ...state, send: noop, cancel: noop, unqueue: async () => null, clear: noop, steer: async () => {}, promote: async () => {}, steerNotice: null };
}

export async function invoke(command: string) {
  if (command === "companion_list") return [{ companionId: "qa", title: "Streaming QA", createdAt: 1 }];
  if (command === "monochat_policy_get") return { conversationTokenBudget: 100000, runTokenBudget: 500000, codexParallelism: 3, claudeParallelism: 3 };
  if (command === "get_agent_seats") return { seats: {} };
  if (/^(companion_get_project|companion_context|browse_thread_harness)$/.test(command)) return null;
  if (command === "companion_build_activity") return false;
  if (/prefs|settings/.test(command)) return null;
  return [];
}
