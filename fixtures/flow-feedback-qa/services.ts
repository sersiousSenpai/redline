// Synthetic service boundary only: no user database, agent or model calls.
// The production components are imported intact; Tauri answers from here.
const noop = () => {};
const qa = window as unknown as Record<string, unknown>;
export async function invoke(command: string, args?: Record<string, unknown>) {
  const log = (qa.__qaInvokes ??= []) as { command: string; args?: Record<string, unknown> }[];
  log.push({ command, args });
  if (command === "get_thread") return [];
  if (command === "fork_thread_status") return { streaming: false, startedAt: null, partial: null, seq: 0, queued: [] };
  if (command === "fork_thread_model") return [null, null];
  if (command === "get_agent_seats") return { seats: {} };
  if (command === "model_catalog_snapshot") return { models: [], checkedAt: 1, source: "harness", warning: null };
  if (/prefs|settings/.test(command)) return null;
  return null;
}
export async function listen() { return noop; }
export async function emit() {}
export async function emitTo() {}
export async function once() { return noop; }
export async function open() { return null; }
export async function openUrl() {}
export function convertFileSrc(path: string) { return path; }
export function isTauri() { return false; }
export function getCurrentWebview() { return { onDragDropEvent: async () => noop }; }
export function getCurrentWindow() { return { startDragging: async () => {}, toggleMaximize: async () => {} }; }
export class Channel { onmessage = noop; }
