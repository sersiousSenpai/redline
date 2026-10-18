// Synthetic service boundary only. Production UI components are imported intact.
const noop = () => {};
const HOUR = 3_600_000;
export async function invoke(command: string, args?: Record<string, unknown>) {
  (window as unknown as { __qaInvokes: unknown[] }).__qaInvokes ??= [];
  (window as unknown as { __qaInvokes: unknown[] }).__qaInvokes.push([command, args ?? null]);
  if (command === "memory_status") {
    return { live: true, itemCount: 1200, backlog: 0, lastOrganizedTs: Date.now() - 2 * HOUR - 60_000, lastOrganizedSummary: null, chainOk: true, compactedCount: 0, reclaimedBytes: 0, lastCompactionTs: null, queuedProposals: 0 };
  }
  if (/prefs|settings/.test(command)) return null;
  return [];
}
export async function listen() { return noop; }
export async function emit() {}
export async function emitTo() {}
export async function once() { return noop; }
export async function open() { return null; }
export async function openUrl() {}
export function convertFileSrc(path: string) { return path; }
export function isTauri() { return false; }
export class Channel { onmessage = noop; }
const fakeWindow = { startDragging: async () => { (window as unknown as { __qaDrags: number }).__qaDrags = ((window as unknown as { __qaDrags?: number }).__qaDrags ?? 0) + 1; }, toggleMaximize: async () => {}, setFullscreen: async () => {}, onResized: async () => noop, onFocusChanged: async () => noop };
export function getCurrentWindow() { return fakeWindow; }
export function getCurrentWebview() { return { onDragDropEvent: async () => noop }; }
export const Window = { getCurrent: getCurrentWindow };
