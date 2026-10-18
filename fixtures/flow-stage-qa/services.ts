// Synthetic Tauri boundary only: every @tauri-apps/* import resolves here.
// The stage's components, the plan editor and the theme are imported intact.
const noop = () => {};
export async function invoke(command: string) {
  if (/prefs|settings|config/.test(command)) return null;
  return null;
}
export async function listen() { return noop; }
export async function once() { return noop; }
export async function emit() {}
export async function emitTo() {}
export function getCurrentWindow() { return { onCloseRequested: async () => noop, isFocused: async () => true, onFocusChanged: async () => noop, setTitle: async () => {} }; }
export function getCurrentWebview() { return { onDragDropEvent: async () => noop }; }
export async function open() { return null; }
export async function openUrl() {}
export async function homeDir() { return "/Users/qa"; }
export function convertFileSrc(path: string) { return path; }
export function isTauri() { return false; }
export class Channel { onmessage = noop; }
