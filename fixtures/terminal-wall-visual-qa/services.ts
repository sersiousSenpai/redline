// Synthetic Tauri boundary for the terminal wall fixture. The header, shelf
// and footer are production components; nothing here reaches a backend.
const noop = () => {};
export async function invoke() { return null; }
export class Channel { onmessage = noop; }
export async function listen() { return noop; }
export async function once() { return noop; }
export async function emit() {}
export function convertFileSrc(path: string) { return path; }
export function isTauri() { return false; }
const surface = { onFocusChanged: async () => noop, onCloseRequested: async () => noop, onDragDropEvent: async () => noop, setFocus: async () => {} };
export function getCurrentWindow() { return surface; }
export function getCurrentWebview() { return surface; }
export function getCurrentWebviewWindow() { return surface; }
