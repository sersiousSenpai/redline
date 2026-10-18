// Synthetic Tauri service boundary only. The sidebar, its row menu and the
// themes are the production components, imported intact.
const noop = () => {};
export async function invoke() { return null; }
export async function listen() { return noop; }
export async function emit() {}
export async function emitTo() {}
export async function once() { return noop; }
export async function open() { return null; }
export async function openUrl() {}
export function convertFileSrc(path: string) { return path; }
export function isTauri() { return false; }
export function getCurrentWebview() { return { onDragDropEvent: async () => noop }; }
export function getCurrentWindow() { return { listen: async () => noop, onFocusChanged: async () => noop }; }
export class Channel { onmessage = noop; }
