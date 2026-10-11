// Synthetic boundary: no user database, model calls, or profile writes.
export function useReadAloud() { return { speaking: false, stop: () => {}, speak: () => {} }; }
export async function listen() { return () => {}; }
export async function emit() {} export async function emitTo() {} export async function once() { return () => {}; }
export async function open() { return null; } export async function openUrl() {}
export function convertFileSrc(path: string) { return path; } export function isTauri() { return false; }
export function getCurrentWindow() { return {
  startDragging: async () => { const page = window as unknown as Record<string, number>; page.__qaWindowDrags = (page.__qaWindowDrags ?? 0) + 1; },
  toggleMaximize: async () => {},
}; }
export class Channel { onmessage = () => {}; }
const noop = () => {};
const messages = [{ id: "q1", companionId: "qa", role: "user", body: "How do we preserve the discussion while changing harnesses?", status: "complete", createdAt: 1 }, { id: "a1", companionId: "qa", role: "assistant", body: "The conversation keeps its history and source anchors. Each turn records the harness it used.\n\nSwitching from Codex to Claude carries a bounded recap into a fresh provider session. Existing action items remain attached to their original document.\n\n- Keep the current document in view.\n- Choose a harness for the next turn.\n- Review the recorded usage in Activity & usage.", status: "complete", createdAt: 2 }];
export function useAgentTurn() { return { messages, liveText: "", status: "idle", startedAt: null, loaded: true, send: noop, cancel: noop, unqueue: noop, clear: noop, meter: null, activity: [], meters: {} }; }
export async function invoke(command: string) {
  if (command === "companion_list") return [{ companionId: "qa", title: "Redline Aurora", createdAt: 1 }];
  if (command === "monochat_policy_get") return { conversationTokenBudget: 100000, runTokenBudget: 500000, codexParallelism: 3, claudeParallelism: 3 };
  if (command === "monochat_traces") return [{ id: "t", surface: "document", intent: "discuss", provider: "codex", model: "CLI default", status: "complete", startedAt: 1, elapsedMs: 1850, meter: null }];
  if (/prefs|settings/.test(command)) return null;
  return [];
}
