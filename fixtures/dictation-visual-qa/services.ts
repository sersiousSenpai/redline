// Synthetic service boundary only: a scripted microphone, a voice backend that
// takes turns, and inert stand-ins for the rest (no user database, model calls
// or profile writes). The composers, the dictation host and its strip are
// imported intact.
// Its state lives on the window: the dev server can load this module once per
// aliased specifier, and every copy must share one set of listeners.
type Handler = (event: { payload: unknown }) => void;
const noop = () => {};
const qa = window as unknown as {
  __qaHandlers?: Map<string, Set<Handler>>;
  __qaCalls: Array<[string, unknown]>;
  __qaEmit: (event: string, payload: unknown) => void;
  __qaDictated: string;
};
const handlers = (qa.__qaHandlers ??= new Map<string, Set<Handler>>());
qa.__qaCalls ??= [];
qa.__qaDictated ??= "";
qa.__qaEmit = (event, payload) => {
  for (const fn of handlers.get(event) ?? []) fn({ payload });
};
let turn = 0;
export async function invoke(command: string, args?: unknown) {
  qa.__qaCalls.push([command, args]);
  switch (command) {
    case "dictation_start":
      return { granted: true, holder: (args as { owner: string }).owner };
    case "dictation_stop":
      return qa.__qaDictated;
    case "voice_session_start":
      return 1;
    case "voice_session_status":
      return { up: true, inFlight: false, generation: 1, turn };
    case "voice_send":
      turn += 1;
      return { generation: 1, turn };
    case "voice_thread":
      return [];
    case "tts_get_settings":
      return { engine: "system" };
    case "companion_list":
      return [{ companionId: "qa", title: "Dictation QA", createdAt: 1 }];
    case "monochat_policy_get":
      return { conversationTokenBudget: 100000, runTokenBudget: 500000, codexParallelism: 3, claudeParallelism: 3 };
  }
  if (/prefs|settings|origin|^(dictation_|voice_|browser_|companion_get|companion_context|browse_thread_harness|import_attachment)/.test(command)) return null;
  return [];
}
export async function listen(event: string, fn: Handler) {
  const set = handlers.get(event) ?? new Set<Handler>();
  set.add(fn);
  handlers.set(event, set);
  return () => set.delete(fn);
}
export async function emit() {}
export async function emitTo() {}
export async function once() { return noop; }
export async function open() { return null; }
export async function openUrl() {}
export function convertFileSrc(path: string) { return path; }
export function isTauri() { return false; }
export function getCurrentWindow() { return { startDragging: async () => {}, toggleMaximize: async () => {} }; }
export function getCurrentWebview() { return { onDragDropEvent: async () => noop }; }
export class Webview {}
export class Channel { onmessage = noop; }
export function useReadAloud() { return { speaking: false, stop: noop, speak: noop }; }
// One exchange already had, so a discussion shows its reply box.
const messages = [
  { id: "u1", role: "user", body: "Why does the anchor drift?", status: "complete", createdAt: 1 },
  { id: "a1", role: "assistant", body: "It is read again on every render, so an edit above it moves it.", status: "complete", createdAt: 2 },
];
export function useAgentTurn() {
  return { messages, liveText: "", status: "idle", startedAt: null, loaded: true, meter: null, activity: [], meters: {}, queue: [], retrying: false,
    send: noop, cancel: noop, unqueue: async () => null, clear: noop, steer: async () => {}, promote: async () => {}, steerNotice: null };
}
